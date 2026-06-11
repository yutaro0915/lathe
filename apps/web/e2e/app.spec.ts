import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { COST_ANOMALY_BASELINE } from "@lathe/shared";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://lathe:lathe@localhost:55432/lathe";

type DbSession = { cost_usd: number | null; token_usage: number };
type DbEvent = {
  id: string;
  seq: number;
  ts: string;
  type: string;
  title: string;
  body: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  token_usage: number | null;
  parent_id: string | null;
  meta: string | null;
};
type DbFileLink = { event_id: string; file_id: string; path: string };
type TurnExpectation = {
  turn: number;
  steps: number;
  edits: number;
  bash: number;
  errors: number;
  tokens: number;
  durationMs: number;
  wallDurationMs: number;
  costUsd: number | null;
  files: DbFileLink[];
};
type CostAnomalyExpectation = {
  session_id: string;
  runner: string;
  cost_usd: number | null;
  cost_anomaly_group_size: number;
  cost_anomaly_group_median_usd: number | null;
  cost_anomaly_threshold_usd: number;
  cost_anomaly: boolean;
};

const turnCache = new Map<string, Promise<TurnExpectation[]>>();
const COST_FIXTURE_IDS = [
  "e2e-cost-fallback-low",
  "e2e-cost-fallback-high",
  "e2e-cost-fallback-null",
] as const;

function fmtCompactForTest(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCostForTest(c: number | null): string {
  if (c == null || !Number.isFinite(c) || c < 0) return "—";
  if (c > 0 && c < 0.01) return "<$0.01";
  return `$${c.toFixed(2)}`;
}

function humanizeDurationForTest(ms: number | null): string {
  if (ms == null) return "—";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function hmsToMsForTest(ts: string): number | null {
  const m = /(\d{2}):(\d{2}):(\d{2})/.exec(ts);
  if (!m) return null;
  return (Number(m[1]) * 60 * 60 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

function readMetaCostForTest(e: DbEvent): number | null {
  if (!e.meta) return null;
  try {
    const meta = JSON.parse(e.meta);
    return typeof meta.costUsd === "number" ? meta.costUsd : null;
  } catch {
    return null;
  }
}

async function getTurnExpectations(sessionId: string): Promise<TurnExpectation[]> {
  const cached = turnCache.get(sessionId);
  if (cached) return cached;

  const promise = (async () => {
    const client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const session = (
        await client.query<DbSession>(
          "SELECT cost_usd, token_usage FROM sessions WHERE id = $1",
          [sessionId]
        )
      ).rows[0];
      const events = (
        await client.query<DbEvent>(
          `SELECT id, seq, ts, type, title, body, exit_code, duration_ms, token_usage, parent_id, meta
             FROM transcript_events
            WHERE session_id = $1
            ORDER BY seq ASC, parent_id NULLS FIRST, id ASC`,
          [sessionId]
        )
      ).rows;
      const links = (
        await client.query<DbFileLink>(
          `SELECT DISTINCT x.event_id, x.file_id, x.path
             FROM (
               SELECT ef.event_id, cf.id AS file_id, cf.path
                 FROM event_files ef
                 JOIN changed_files cf ON cf.session_id = $1 AND cf.path = ef.path
                WHERE ef.event_id IN (SELECT id FROM transcript_events WHERE session_id = $1)
               UNION
               SELECT a.event_id, cf.id AS file_id, cf.path
                 FROM changed_files cf
                 JOIN diff_hunks h ON h.file_id = cf.id
                 JOIN attributions a ON a.hunk_id = h.id
                WHERE cf.session_id = $1
                  AND a.event_id IS NOT NULL
             ) x`,
          [sessionId]
        )
      ).rows;

      const topEvents = events.filter((e) => !e.parent_id);
      const childrenByParent = new Map<string, DbEvent[]>();
      for (const e of events) {
        if (!e.parent_id) continue;
        const arr = childrenByParent.get(e.parent_id) ?? [];
        arr.push(e);
        childrenByParent.set(e.parent_id, arr);
      }

      const linksByEvent = new Map<string, Map<string, DbFileLink>>();
      for (const link of links) {
        const arr = linksByEvent.get(link.event_id) ?? new Map<string, DbFileLink>();
        arr.set(link.file_id, link);
        linksByEvent.set(link.event_id, arr);
      }

      let turn = 0;
      let headerId: string | null = null;
      const turnByEvent = new Map<string, { turn: number; headerId: string }>();
      for (const e of topEvents) {
        if (e.type === "user_message") {
          turn += 1;
          headerId = e.id;
        }
        if (headerId) turnByEvent.set(e.id, { turn, headerId });
      }

      const rollups = new Map<
        string,
        TurnExpectation & { fileMap: Map<string, DbFileLink> }
      >();
      for (const e of topEvents) {
        const owner = turnByEvent.get(e.id);
        if (e.type !== "user_message" || !owner) continue;
        rollups.set(e.id, {
          turn: owner.turn,
          steps: 0,
          edits: 0,
          bash: 0,
          errors: 0,
          tokens: 0,
          durationMs: 0,
          wallDurationMs: 0,
          costUsd: null,
          files: [],
          fileMap: new Map(),
        });
      }

      const collect = (
        rollup: TurnExpectation & { fileMap: Map<string, DbFileLink> },
        e: DbEvent
      ) => {
        if (e.type === "file_edit" || e.type === "file_write") rollup.edits += 1;
        if (e.type === "bash") rollup.bash += 1;
        if (e.type === "error" || (e.exit_code != null && e.exit_code !== 0)) rollup.errors += 1;
        rollup.tokens += e.token_usage ?? 0;
        rollup.durationMs += e.duration_ms ?? 0;
        const directCost = readMetaCostForTest(e);
        const tokenCost =
          directCost == null && session?.cost_usd != null && session.token_usage > 0 && e.token_usage != null
            ? (session.cost_usd * e.token_usage) / session.token_usage
            : null;
        const cost = directCost ?? tokenCost;
        if (cost != null) rollup.costUsd = (rollup.costUsd ?? 0) + cost;
        for (const file of linksByEvent.get(e.id)?.values() ?? []) rollup.fileMap.set(file.file_id, file);
      };

      for (const e of topEvents) {
        const owner = turnByEvent.get(e.id);
        if (!owner) continue;
        const rollup = rollups.get(owner.headerId);
        if (!rollup) continue;
        if (e.id !== owner.headerId) rollup.steps += 1;
        collect(rollup, e);
        for (const child of childrenByParent.get(e.id) ?? []) collect(rollup, child);
      }

      const dayMs = 24 * 60 * 60 * 1000;
      const sessionStart = hmsToMsForTest(topEvents[0]?.ts ?? "") ?? 0;
      const normalizeMs = (e: DbEvent | undefined) => {
        const raw = e ? hmsToMsForTest(e.ts) : null;
        if (raw == null) return sessionStart;
        return raw < sessionStart ? raw + dayMs : raw;
      };
      const headers = topEvents.filter((e) => e.type === "user_message");
      const lastTop = topEvents.at(-1);
      for (let i = 0; i < headers.length; i += 1) {
        const rollup = rollups.get(headers[i].id);
        if (!rollup) continue;
        const start = normalizeMs(headers[i]);
        const end = i + 1 < headers.length ? normalizeMs(headers[i + 1]) : normalizeMs(lastTop);
        rollup.wallDurationMs = Math.max(0, end - start);
      }

      return [...rollups.values()]
        .sort((a, b) => a.turn - b.turn)
        .map(({ fileMap, ...r }) => ({ ...r, files: [...fileMap.values()] }));
    } finally {
      await client.end();
    }
  })();
  turnCache.set(sessionId, promise);
  return promise;
}

async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function seedCostFallbackFixtures() {
  const { absoluteFloorUsd } = COST_ANOMALY_BASELINE;
  await withDb(async (client) => {
    await client.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [COST_FIXTURE_IDS]);
    const rows = [
      {
        id: COST_FIXTURE_IDS[0],
        title: "E2E fallback cost low",
        cost: absoluteFloorUsd - 1,
        seq: 2,
      },
      {
        id: COST_FIXTURE_IDS[1],
        title: "E2E fallback cost high",
        cost: absoluteFloorUsd + 1,
        seq: 3,
      },
      {
        id: COST_FIXTURE_IDS[2],
        title: "E2E fallback cost null",
        cost: null,
        seq: 4,
      },
    ];
    for (const r of rows) {
      await client.query(
        `INSERT INTO sessions (
           id, project, title, runner, model, status, started_at, ended_at, duration_ms,
           turn_count, tool_count, edit_count, bash_count, subagent_count, error_count,
           token_usage, token_in, token_out, git_branch, commit_count, cost_usd, summary, seq
         ) VALUES (
           $1, 'LLMWiki', $2, 'cursor', 'e2e-cost-baseline', 'done',
           '2026-06-11 00:00:00', '2026-06-11 00:00:01', 1000,
           1, 0, 0, 0, 0, 0,
           0, 0, 0, 'loop/12-g9-cost-anomaly', 0, $3, NULL, $4
         )`,
        [r.id, r.title, r.cost, r.seq]
      );
    }
  });
}

async function cleanupCostFallbackFixtures() {
  await withDb((client) =>
    client.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [COST_FIXTURE_IDS]).then(() => undefined)
  );
}

async function getCostAnomalyExpectations(
  sessionIds?: readonly string[]
): Promise<CostAnomalyExpectation[]> {
  const { minimumGroupSize, absoluteFloorUsd, medianMultiplier } = COST_ANOMALY_BASELINE;
  return withDb(async (client) => {
    const params: unknown[] = [minimumGroupSize, absoluteFloorUsd, medianMultiplier];
    const where = sessionIds?.length ? "WHERE session_id = ANY($4::text[])" : "";
    if (sessionIds?.length) params.push(sessionIds);
    const rows = await client.query<CostAnomalyExpectation>(
      `WITH cost_baseline AS (
         SELECT runner,
                COUNT(cost_usd)::int AS cost_anomaly_group_size,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)::float8 AS cost_anomaly_group_median_usd
           FROM sessions
          WHERE cost_usd IS NOT NULL
          GROUP BY runner
       ),
       scored AS (
         SELECT s.id AS session_id,
                s.runner,
                s.cost_usd,
                COALESCE(b.cost_anomaly_group_size, 0)::int AS cost_anomaly_group_size,
                b.cost_anomaly_group_median_usd,
                CASE
                  WHEN s.cost_usd IS NULL THEN $2::float8
                  WHEN COALESCE(b.cost_anomaly_group_size, 0) < $1::int THEN $2::float8
                  WHEN b.cost_anomaly_group_median_usd IS NULL THEN $2::float8
                  ELSE GREATEST(b.cost_anomaly_group_median_usd * $3::float8, $2::float8)
                END AS cost_anomaly_threshold_usd
           FROM sessions s
           LEFT JOIN cost_baseline b ON b.runner = s.runner
       )
       SELECT scored.*,
              (
                cost_usd IS NOT NULL
                AND cost_usd > cost_anomaly_threshold_usd
              ) AS cost_anomaly
         FROM scored
         ${where}
        ORDER BY session_id ASC`,
      params
    );
    return rows.rows;
  });
}

function highestCostTurn(turns: TurnExpectation[]): TurnExpectation {
  const candidates = turns.filter((t) => t.steps > 0 && t.costUsd != null);
  return candidates.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.turn - b.turn)[0];
}

function longestWallDurationTurn(turns: TurnExpectation[]): TurnExpectation {
  const candidates = turns.filter((t) => t.steps > 0);
  return candidates.sort((a, b) => b.wallDurationMs - a.wallDurationMs || a.turn - b.turn)[0];
}

async function findCompactCodexSession(): Promise<string> {
  const rows = await withDb(async (client) =>
    (
      await client.query<{ id: string }>(
        `SELECT s.id
           FROM sessions s
           JOIN transcript_events e ON e.session_id = s.id
          WHERE s.runner = 'codex'
          GROUP BY s.id, s.duration_ms
         HAVING COUNT(*) FILTER (WHERE e.type = 'user_message') > 1
            AND COUNT(*) < 300
          ORDER BY s.duration_ms DESC NULLS LAST
          LIMIT 20`
      )
    ).rows
  );
  for (const row of rows) {
    const target = longestWallDurationTurn(await getTurnExpectations(row.id));
    if (target?.wallDurationMs > 0) return row.id;
  }
  throw new Error("No compact Codex session with a non-zero wall-clock turn duration");
}

async function expectTurnJump(
  page: Page,
  sessionId: string,
  buttonText: string,
  targetTurn: TurnExpectation,
  expectedBasis?: "cost" | "duration"
) {
  await page.goto(`/?session=${sessionId}`);
  const jump = page.locator(".sessbar .jump-chip", { hasText: buttonText });
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAttribute("data-turn", String(targetTurn.turn));
  if (expectedBasis) await expect(jump).toHaveAttribute("data-turn-score-basis", expectedBasis);
  await jump.click();
  const header = page.locator(`.timeline .event-row.turn-header[data-turn="${targetTurn.turn}"]`);
  await expect(header).toHaveClass(/selected/);
  await expect(
    page.locator(`.timeline .event-row.step-row[data-turn="${targetTurn.turn}"]`).first()
  ).toBeVisible();
}

test.beforeAll(async () => {
  await seedCostFallbackFixtures();
});

test.afterAll(async () => {
  await cleanupCostFallbackFixtures();
});

async function expandAllTurns(page: Page) {
  const expand = page.locator(".turn-filter button", { hasText: "Expand turns" });
  if ((await expand.count()) > 0) await expand.click();
}

// Assertions are structural (counts change, classes toggle, URL changes) rather
// than tied to specific seeded titles, so they stay green as the ingested
// transcripts grow.

test.describe("Session viewer (/)", () => {
  test("loads with sessions, a named header and a timeline", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".session-item").first()).toBeVisible();
    // refined header: session is named + a compact stat cluster
    await expect(page.locator(".sessbar .sessbar-title")).toBeVisible();
    await expect(page.locator(".sessbar .sessbar-stats")).toContainText("tokens");
    expect(await page.locator(".event-row").count()).toBeGreaterThan(0);
  });

  test("tabs switch the centre content", async ({ page }) => {
    await page.goto("/");
    const tabs = page.locator(".tabs .tab");
    await tabs.filter({ hasText: "Raw JSON" }).click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Raw JSON/);
    await tabs.filter({ hasText: "Subagents" }).click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Subagents/);
    await tabs.filter({ hasText: "Transcript" }).click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
    await expect(page.locator(".event-row").first()).toBeVisible();
  });

  test("event-type filter reduces the timeline", async ({ page }) => {
    await page.goto("/");
    const before = await page.locator(".event-row").count();
    await page.locator(".filters .event-type-badge").first().click();
    await expect
      .poll(async () => page.locator(".event-row").count())
      .toBeLessThan(before);
  });

  test("clicking an event selects it (detail panel)", async ({ page }) => {
    await page.goto("/");
    const rows = page.locator(".event-row");
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    await rows.nth(Math.min(5, n - 1)).click();
    await expect(page.locator(".event-row.selected")).toHaveCount(1);
  });

  test("session search filters the list and clears", async ({ page }) => {
    await page.goto("/");
    const before = await page.locator(".session-item").count();
    const box = page.getByPlaceholder(/Search sessions/i);
    await box.fill("zzz-no-such-session-zzz");
    await expect(page.locator(".session-item")).toHaveCount(0);
    await box.fill("");
    await expect(page.locator(".session-item")).toHaveCount(before);
  });

  test("switching session navigates with ?session=", async ({ page }) => {
    await page.goto("/");
    await page.locator(".session-item").nth(1).click();
    await expect(page).toHaveURL(/\?session=/);
    await expect(page.locator(".session-item.active")).toHaveCount(1);
  });

  test("Pin persists to localStorage", async ({ page }) => {
    await page.goto("/");
    await page.locator(".event-row").nth(0).click();
    await page.locator(".btn", { hasText: /Pin/i }).first().click();
    const pins = await page.evaluate(() => localStorage.getItem("lathe.pins"));
    expect(pins && pins.length).toBeTruthy();
  });

  test("cost is derived from token usage and shown ($)", async ({ page }) => {
    await page.goto("/");
    // header stat cluster has a Cost figure
    await expect(
      page.locator(".sessbar-stats .kstat", { hasText: "cost" })
    ).toBeVisible();
    // priceable (Opus) sessions show a real dollar amount in the list, not "—"
    const dollarCosts = page.locator(".session-item .chip.cost", { hasText: "$" });
    expect(await dollarCosts.count()).toBeGreaterThan(0);
  });
});

test.describe("Cost anomaly detection", () => {
  const CLAUDE_JUMP_SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";

  test("session-list anomaly chips match an independent DB baseline oracle", async ({ page }) => {
    const oracle = await getCostAnomalyExpectations();
    const expected = oracle
      .filter((r) => r.cost_anomaly)
      .map((r) => r.session_id)
      .sort();

    await page.goto("/");
    const actual = (
      await page.locator(".session-list .session-item").evaluateAll((items) =>
        items
          .filter((item) => item.querySelector(".anomaly-chip"))
          .map((item) => item.getAttribute("data-session-id"))
          .filter((id): id is string => !!id)
      )
    ).sort();

    expect(actual).toEqual(expected);
  });

  test("n<10 groups and cost-NULL sessions use the absolute-floor fallback", async ({ page }) => {
    const oracle = await getCostAnomalyExpectations(COST_FIXTURE_IDS);
    const byId = new Map(oracle.map((r) => [r.session_id, r]));
    const low = byId.get(COST_FIXTURE_IDS[0])!;
    const high = byId.get(COST_FIXTURE_IDS[1])!;
    const nil = byId.get(COST_FIXTURE_IDS[2])!;

    for (const row of [low, high, nil]) {
      expect(row.cost_anomaly_group_size).toBeLessThan(COST_ANOMALY_BASELINE.minimumGroupSize);
      expect(row.cost_anomaly_threshold_usd).toBe(COST_ANOMALY_BASELINE.absoluteFloorUsd);
    }
    expect(low.cost_anomaly).toBe(false);
    expect(high.cost_anomaly).toBe(true);
    expect(nil.cost_usd).toBeNull();
    expect(nil.cost_anomaly).toBe(false);

    await page.goto("/");
    await page.getByPlaceholder(/Search sessions/i).fill("E2E fallback cost");
    await expect(page.locator(".session-list .session-item")).toHaveCount(3);
    await expect(
      page.locator(`.session-item[data-session-id="${COST_FIXTURE_IDS[1]}"] .anomaly-chip`)
    ).toHaveText("▲ cost");
    await expect(
      page.locator(`.session-item[data-session-id="${COST_FIXTURE_IDS[0]}"] .anomaly-chip`)
    ).toHaveCount(0);
    await expect(
      page.locator(`.session-item[data-session-id="${COST_FIXTURE_IDS[2]}"] .anomaly-chip`)
    ).toHaveCount(0);
  });

  test("overview shows the same anomaly chip in scoped session rows", async ({ page }) => {
    await page.goto("/overview");
    await page.locator(".project-picker").selectOption("(no edits)");
    await expect(
      page.locator(`.overview-shell .session-item[data-session-id="${COST_FIXTURE_IDS[1]}"] .anomaly-chip`)
    ).toHaveText("▲ cost");
  });

  test("highest-turn jump expands and activates the estimated-cost turn for Claude Code", async ({ page }) => {
    const target = highestCostTurn(await getTurnExpectations(CLAUDE_JUMP_SID));
    expect(target).toBeTruthy();
    await expectTurnJump(page, CLAUDE_JUMP_SID, "最も高い turn へ", target, "cost");
  });

  test("highest-turn jump expands and activates the duration fallback turn for Codex", async ({ page }) => {
    const codexSession = await findCompactCodexSession();
    const target = longestWallDurationTurn(await getTurnExpectations(codexSession));
    expect(target).toBeTruthy();
    expect(target.wallDurationMs).toBeGreaterThan(0);
    await expectTurnJump(page, codexSession, "最も高い turn へ", target, "duration");
  });

  test("error-turn jump expands and activates the first failing turn", async ({ page }) => {
    const target = (await getTurnExpectations(CLAUDE_JUMP_SID)).find(
      (t) => t.steps > 0 && t.errors > 0
    );
    expect(target).toBeTruthy();
    await expectTurnJump(page, CLAUDE_JUMP_SID, "エラー turn へ", target!);
  });
});

test.describe("Diff viewer (/diff)", () => {
  test("loads with changed files and a diff", async ({ page }) => {
    await page.goto("/diff");
    await expect(page.locator(".file-row").first()).toBeVisible();
    expect(await page.locator(".diff-hunk").count()).toBeGreaterThan(0);
  });

  test("selecting a file updates the diff path", async ({ page }) => {
    await page.goto("/diff");
    const before = await page.locator(".fpath").innerText();
    const files = page.locator(".file-row:not(.is-folder)");
    const count = await files.count();
    for (let i = 0; i < count; i++) {
      const f = files.nth(i);
      const cls = (await f.getAttribute("class")) || "";
      if (!cls.includes("active")) {
        await f.click();
        break;
      }
    }
    await expect(page.locator(".fpath")).not.toHaveText(before);
  });

  test("unified/split toggle changes the diff layout", async ({ page }) => {
    await page.goto("/diff");
    const diff = page.locator(".diff");
    const before = await diff.innerHTML();
    // scope to the view-mode toggle (a separate .segmented.step-filter may exist)
    const viewToggle = page.locator(".diff-toolbar .segmented:not(.step-filter)");
    await viewToggle.locator("button", { hasText: "Split" }).click();
    await expect(viewToggle.locator("button.active")).toHaveText(/Split/);
    await expect.poll(async () => diff.innerHTML()).not.toBe(before);
  });

  test("folder twisty collapses its children", async ({ page }) => {
    await page.goto("/diff");
    const folders = page.locator(".file-row.is-folder");
    if ((await folders.count()) > 0) {
      const before = await page.locator(".file-row").count();
      await folders.first().click();
      await expect
        .poll(async () => page.locator(".file-row").count())
        .toBeLessThan(before);
    }
  });

  test("Raw JSON button reveals the event JSON", async ({ page }) => {
    await page.goto("/diff");
    const btn = page.locator(".btn", { hasText: /Raw JSON/i }).first();
    if ((await btn.count()) > 0) {
      const preBefore = await page.locator("pre").count();
      await btn.click();
      await expect.poll(async () => page.locator("pre").count()).toBeGreaterThan(preBefore);
    }
  });

  test("linked events stack (meta below title, no le-right overlap)", async ({ page }) => {
    await page.goto("/diff");
    const le = page.locator(".linked-event").first();
    if ((await le.count()) > 0) {
      await expect(le.locator(".le-turn")).toHaveCount(1);
      await expect(le.locator(".le-meta")).toHaveCount(1);
      // old overlapping layout used .le-right; it must be gone
      await expect(le.locator(".le-right")).toHaveCount(0);
    }
  });

  test("the session list stays on the Git tab (can switch sessions)", async ({ page }) => {
    await page.goto("/diff"); // redirects to /?session=…&tab=git
    // the diff is embedded; the host session list is still in the sidebar
    await expect(page.locator(".diff-embed")).toBeVisible();
    const items = page.locator(".session-list .session-item");
    await expect(items.first()).toBeVisible();
    if ((await items.count()) > 1) {
      await items.nth(1).click();
      await expect(page).toHaveURL(/session=/);
    }
  });
});

test.describe("Cross-screen navigation & time ribbon", () => {
  test("Git is an in-page tab: diff shows, session list stays, no navigation", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".tabs .tab", { hasText: "Git" }).click();
    // does NOT navigate away to /diff…
    await expect(page).not.toHaveURL(/\/diff/);
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Git/);
    // …the diff working area is embedded in place…
    await expect(page.locator(".diff-embed")).toBeVisible();
    // …and the session list sidebar is still there to switch sessions.
    await expect(page.locator(".session-list .session-item").first()).toBeVisible();
  });

  test("from the Git tab, other tabs switch in-page (no /diff page)", async ({ page }) => {
    await page.goto("/diff"); // redirects to /?session=…&tab=git
    await expect(page).not.toHaveURL(/\/diff/);
    await page.locator(".tabs .tab", { hasText: "Transcript" }).click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
    await expect(page.locator(".timeline .event-row").first()).toBeVisible();
  });

  test("?tab opens the viewer on that tab", async ({ page }) => {
    await page.goto("/?tab=subagents");
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Subagents/);
  });

  test("time ribbon renders with segments on the session viewer", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".ribbon-track")).toBeVisible();
    expect(await page.locator(".ribbon-seg").count()).toBeGreaterThan(0);
  });

  test("time ribbon zoom widens the track", async ({ page }) => {
    await page.goto("/");
    const track = page.locator(".ribbon-track");
    const w0 = await track.evaluate((el) => el.style.width);
    await page.locator(".ribbon .minimap-zoom button", { hasText: "+" }).click();
    await expect.poll(async () => track.evaluate((el) => el.style.width)).not.toBe(w0);
  });
});

test.describe("Event detail panel", () => {
  test("shows compact stats (duration/exit) and a wrapping output", async ({ page }) => {
    await page.goto("/?session=da2ac032-a905-4267-8e5f-851456926a79");
    await expandAllTurns(page);
    const bashRow = page
      .locator(".event-row")
      .filter({ has: page.locator(".event-icon.bash") })
      .first();
    if ((await bashRow.count()) > 0) {
      await bashRow.click();
      await expect(page.locator(".stat-strip .stat").first()).toBeVisible();
      await expect(page.locator(".code-block.output")).toBeVisible();
      const ws = await page
        .locator(".code-block.output")
        .evaluate((el) => getComputedStyle(el).whiteSpace);
      expect(ws).toBe("pre-wrap"); // output wraps, no horizontal cut-off
      // the old tall key/value table is gone
      await expect(page.locator(".detail .kv dt")).toHaveCount(0);
    }
  });
});

test.describe("Thinking", () => {
  test("thinking events are captured and viewable", async ({ page }) => {
    // a session with extended-thinking (non-redacted) blocks
    await page.goto("/?session=b1dcf7bd-a268-4304-bc4a-b45463538aa2");
    await expandAllTurns(page);
    const trow = page
      .locator(".event-row")
      .filter({ has: page.locator(".event-icon.thinking") })
      .first();
    if ((await trow.count()) > 0) {
      await trow.click();
      await expect(page.locator(".detail-head .dtitle")).toHaveText(/Thinking/);
      const body = (await page.locator(".code-block.output").innerText()).trim();
      expect(body.length).toBeGreaterThan(0);
    }
  });
});

test.describe("Sub-agent expansion", () => {
  test("sub-agent rows expand to reveal child steps (tools/skills)", async ({ page }) => {
    // a session known to spawn general-purpose sub-agents
    await page.goto("/?session=da2ac032-a905-4267-8e5f-851456926a79");
    await expandAllTurns(page);
    // pick the expander on a SUB-AGENT row (not a turn-header user_message —
    // they now share the .tw-expand class for ▾/▸ toggles).
    const saExpander = page
      .locator(".event-row:not(.turn-header)")
      .filter({ has: page.locator(".event-icon.subagent") })
      .first()
      .locator(".tw-expand");
    if ((await saExpander.count()) > 0) {
      const before = await page.locator(".event-row").count();
      await saExpander.click();
      await expect
        .poll(async () => page.locator(".event-row.child-row").count())
        .toBeGreaterThan(0);
      expect(await page.locator(".event-row").count()).toBeGreaterThan(before);
      // a child step should be a real tool/message of the sub-agent
      await expect(page.locator(".event-row.child-row").first()).toBeVisible();
    }
  });
});

test.describe("Sub-agent runs (Subagents tab)", () => {
  // session known to spawn 3 distinct general-purpose runs
  const SID = "da2ac032-a905-4267-8e5f-851456926a79";

  test("overview lists one card per distinct run, not one flat list per name", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    // a tab bar with Overview + one tab per run
    await expect(page.locator(".sa-tab").first()).toContainText(/Overview/);
    const runTabs = page.locator(".sa-tab").filter({ hasText: "general-purpose" });
    expect(await runTabs.count()).toBeGreaterThan(1); // distinct runs, not merged
    // overview shows a card per run with a step count
    const cards = page.locator(".sa-card");
    expect(await cards.count()).toBe(await runTabs.count());
    await expect(cards.first().locator(".sa-card-meta")).toContainText(/steps/);
  });

  test("clicking a run opens its detail tab with the internal execution", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(".sa-card").first().click();
    // the tabbar reflects the opened run + per-run execution rows appear
    await expect(page.locator(".sa-tabbar .sa-tab.active .sa-tab-idx")).toHaveText("1");
    await expect
      .poll(async () => page.locator(".sa-detail .event-row.child-row").count())
      .toBeGreaterThan(0);
    // selecting an internal step drives the right detail panel
    await page.locator(".sa-detail .event-row.child-row").first().click();
    await expect(page.locator(".sa-detail .event-row.child-row.selected")).toHaveCount(1);
    await expect(page.locator(".detail .detail-head .dtitle")).toBeVisible();
  });

  test("tabbar steps between runs", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(".sa-card").first().click();
    await expect(page.locator(".sa-tabbar .sa-tab.active .sa-tab-idx")).toHaveText("1");
    await page.locator(".sa-tabbar .sa-tab", { has: page.locator(".sa-tab-idx", { hasText: "2" }) }).click();
    await expect(page.locator(".sa-tabbar .sa-tab.active .sa-tab-idx")).toHaveText("2");
    await expect.poll(async () => page.locator(".sa-detail .event-row.child-row").count()).toBeGreaterThan(0);
  });

  test("a launcher row in the transcript jumps to its run detail", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    await expandAllTurns(page);
    const jump = page.locator(".sa-jump").first();
    if ((await jump.count()) > 0) {
      await jump.click();
      await expect(page.locator(".tabs .tab.active")).toHaveText(/Subagents/);
      await expect(page.locator(".sa-tabbar .sa-tab.active .sa-tab-idx")).toBeVisible();
    }
  });

  test("each run shows which model ran and its cost", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    // overview cards carry a model chip + a $ cost
    await expect(page.locator(".sa-card .sa-model").first()).toBeVisible();
    await expect(page.locator(".sa-card .sa-cost").first()).toContainText("$");
    // the detail view exposes Model + Cost stats
    await page.locator(".sa-tab", { hasText: "general-purpose" }).first().click();
    await expect(
      page.locator(".sa-detail-stats .stat", { hasText: "Model" })
    ).toBeVisible();
    await expect(
      page.locator(".sa-detail-stats .stat", { hasText: "Cost" })
    ).toBeVisible();
  });

  test("opening a run does NOT duplicate the run into the right aside; it asks for a step", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(".sa-card").first().click();
    // run is open in the centre (stats strip is the canonical place)
    await expect(page.locator(".sa-detail-stats")).toBeVisible();
    // the right aside is reserved for the selected EXECUTION step — until one is
    // picked it shows a quiet placeholder, not a second copy of the run detail
    await expect(
      page.locator('.aside [data-aside-placeholder="step-inspect"]')
    ).toBeVisible();
    await expect(page.locator(".aside .detail-head")).toHaveCount(0);
    // picking a step swaps the aside to that step's detail (placeholder gone)
    await expect
      .poll(async () => page.locator(".sa-detail .event-row.child-row").count())
      .toBeGreaterThan(0);
    await page.locator(".sa-detail .event-row.child-row").first().click();
    await expect(
      page.locator('.aside [data-aside-placeholder="step-inspect"]')
    ).toHaveCount(0);
    await expect(page.locator(".aside .detail-head .dtitle")).toBeVisible();
  });

  test("Result = the run's own verdict; child-step failures are a separate count", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(".sa-card").first().click();
    const result = page.locator(".sa-detail-stats .stat", { hasText: "Result" }).locator(".stat-v");
    await expect(result).toHaveText(/^(ok|error)$/);
    // if any child step failed, that fact is surfaced under Steps (NOT folded
    // into Result) — so "ok" + "N failed" can coexist without contradiction.
    const note = page.locator(".sa-detail-stats .failed-steps-note");
    if ((await note.count()) > 0) {
      await expect(note.first()).toContainText(/failed/);
    }
  });
});

test.describe("Changed-files tree (compact folders)", () => {
  // session with files nested 8+ levels deep down single-child chains
  const SID = "78a6e038-3829-43bb-98c8-404e8afa8ccc";

  test("single-child folder chains collapse; rows ≈ files, not a row per dir level", async ({
    page,
  }) => {
    await page.goto(`/diff?session=${SID}`);
    await expect(page.locator(".filetree-head .sub")).toHaveText(/5 files changed/);
    // exactly the 5 real files appear as file rows...
    await expect(page.locator(".file-row.is-file")).toHaveCount(5);
    // ...and the whole tree stays compact (no per-directory-level explosion)
    expect(await page.locator(".file-row").count()).toBeLessThanOrEqual(10);
    // a deep chain is merged into ONE folder row whose name carries the "/"-joined path
    const merged = page
      .locator(".file-row.is-folder .fname")
      .filter({ hasText: "/" });
    expect(await merged.count()).toBeGreaterThan(0);
  });

  test("files and folders are visually distinct (status chip vs folder icon)", async ({
    page,
  }) => {
    await page.goto(`/diff?session=${SID}`);
    // files carry a colored A/M/D status chip; folders carry a folder icon, no chip
    await expect(page.locator(".file-row.is-file .status-chip").first()).toBeVisible();
    expect(await page.locator(".file-row.is-folder .ficon.folder svg").count()).toBeGreaterThan(0);
    expect(await page.locator(".file-row.is-folder .status-chip").count()).toBe(0);
  });
});

test.describe("Time ribbon & annotations", () => {
  test("ribbon: hovering reads out the exact time + step", async ({ page }) => {
    await page.goto("/");
    const track = page.locator(".ribbon-track");
    await expect(track).toBeVisible();
    const box = await track.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
      await expect(page.locator(".ribbon-read")).toContainText(/\d{2}:\d{2}:\d{2}/);
    }
  });

  test("ribbon: clicking the track selects the step at the cursor", async ({ page }) => {
    await page.goto("/");
    const track = page.locator(".ribbon-track");
    const box = await track.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
      await expect(page.locator(".event-row.selected")).toHaveCount(1);
    }
  });

  test("ribbon: zooming in adds more time-axis ticks", async ({ page }) => {
    await page.goto("/");
    const before = await page.locator(".ribbon-axis .tick").count();
    await page.locator(".minimap-zoom button", { hasText: "+" }).click();
    await page.locator(".minimap-zoom button", { hasText: "+" }).click();
    await expect
      .poll(async () => page.locator(".ribbon-axis .tick").count())
      .toBeGreaterThan(before);
  });

  test("annotations are labelled (kind + step) and jump on click", async ({ page }) => {
    // a session with errors + commits flagged — annotations now live in their
    // own top-level tab (moved out of the right aside, which was context-wrong).
    await page.goto("/?session=4912b75c-6018-427c-b67b-00a583404d21&tab=annotations");
    const ann = page.locator(".annotations-tab .annotation").first();
    if ((await ann.count()) > 0) {
      await expect(ann.locator(".akind-tag")).toBeVisible();
      await expect(ann.locator(".aseq")).toContainText(/step/);
      await ann.click();
      // clicking jumps INTO the Transcript tab and selects the step there
      await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
      await expect(page.locator(".event-row.selected")).toHaveCount(1);
    }
  });
});

test.describe("Annotations tab (moved out of the right aside)", () => {
  // session known to carry flagged moments (errors + commits)
  const SID = "4912b75c-6018-427c-b67b-00a583404d21";

  test("there is an Annotations tab with a count badge, and the aside no longer hosts annotations", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=annotations`);
    const tab = page.locator(".tabs .tab", { hasText: "Annotations" });
    await expect(tab).toBeVisible();
    const count = await page.locator(".annotations-tab .annotation").count();
    if (count > 0) {
      // count badge reflects the number of flagged moments
      await expect(tab.locator(".tab-count")).toHaveText(String(count));
    }
    // the old right-aside annotations strip is gone everywhere
    await expect(page.locator(".aside .annotations")).toHaveCount(0);
  });

  test("annotations are listed in time order (at_seq ascending)", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=annotations`);
    const seqs = await page
      .locator(".annotations-tab .annotation")
      .evaluateAll((rows) =>
        (rows as HTMLElement[]).map((r) => Number(r.getAttribute("data-annotation-seq")))
      );
    if (seqs.length > 1) {
      const sorted = [...seqs].sort((a, b) => a - b);
      expect(seqs).toEqual(sorted);
    }
  });
});

test.describe("Stats tab (in-session)", () => {
  test("the Stats tab shows charts for THIS session only (not cross-session)", async ({
    page,
  }) => {
    await page.goto("/?tab=stats");
    // sessbar still names the SESSION (not 'Overview'/'Statistics'): the tab is
    // per-session by design — cross-session analytics live at /overview.
    await expect(page.locator(".sessbar-title")).not.toHaveText(/^(Overview|Statistics)/);
    await expect(page.locator(".stats-embed")).toBeVisible();
    // the headline chart is per-turn for this run
    await expect(
      page.locator(".chart-card", { hasText: "Where this session went" })
    ).toBeVisible();
    // per-turn SVG + event composition / files / sub-agent bars
    expect(await page.locator(".chart-svg rect").count()).toBeGreaterThan(0);
    expect(await page.locator(".hbar-row").count()).toBeGreaterThan(0);
  });

  test("the in-session Stats sidebar exposes an Overview link to cross-session analytics", async ({
    page,
  }) => {
    await page.goto("/?tab=stats");
    const link = page.locator(".overview-link");
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/overview/);
  });
});

test.describe("Overview (/overview) — cross-session analytics", () => {
  test("/overview renders the four cross-session charts", async ({ page }) => {
    await page.goto("/overview");
    await expect(page.locator(".sessbar-title")).toHaveText(/Overview/);
    await expect(page.locator(".stats-embed")).toBeVisible();
    // four charts: cost-over-time + cost-by-model + event composition + biggest
    expect(await page.locator(".chart-card").count()).toBeGreaterThanOrEqual(4);
    expect(await page.locator(".chart-svg rect").count()).toBeGreaterThan(0);
    expect(await page.locator(".hbar-row").count()).toBeGreaterThan(0);
  });

  test("legacy /stats redirects to /overview", async ({ page }) => {
    await page.goto("/stats");
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.locator(".sessbar-title")).toHaveText(/Overview/);
  });

  test("the project selector scopes the cross-session charts", async ({ page }) => {
    await page.goto("/overview");
    const picker = page.locator(".project-picker");
    const values = await picker
      .locator("option")
      .evaluateAll((opts) =>
        (opts as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== "all")
      );
    expect(values.length).toBeGreaterThan(0);
    await picker.selectOption(values[0]);
    await expect(page.locator(".sessbar-meta")).not.toContainText("All projects");
    await expect(page.locator(".chart-card").first()).toBeVisible();
  });

  test("a session in the overview sidebar jumps into the session viewer", async ({
    page,
  }) => {
    await page.goto("/overview");
    await page.locator(".overview-shell .session-list .session-item").first().click();
    await expect(page).toHaveURL(/\?session=/);
  });
});

test.describe("Harness signals", () => {
  test("nested memory loads & hook firings appear in the transcript + filters", async ({
    page,
  }) => {
    await page.goto("/?session=da2ac032-a905-4267-8e5f-851456926a79");
    await expandAllTurns(page);
    // event-type filter exposes Memory + Hook
    await expect(
      page.locator(".filters .event-type-badge", { hasText: "Memory" })
    ).toBeVisible();
    await expect(
      page.locator(".filters .event-type-badge", { hasText: "Hook" })
    ).toBeVisible();
    // and at least one memory event renders in the timeline with its own icon
    await expect(page.locator(".timeline .event-icon.memory").first()).toBeVisible();
  });

  test("the overview charts break down where the actions went across sessions", async ({
    page,
  }) => {
    await page.goto("/overview");
    // memory loads / hook firings are first-class event types — they roll up into
    // the cross-session event-composition chart (and stay filterable in transcripts).
    await expect(
      page.locator(".chart-card", { hasText: "Where the actions went" })
    ).toBeVisible();
    await expect(page.locator(".chart-card .hbar-row").first()).toBeVisible();
  });
});

test.describe("Codex support", () => {
  test("Codex sessions are ingested and shown alongside Claude (runner badge)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.locator(".session-list .runner-badge", { hasText: "Codex" }).first()
    ).toBeVisible();
  });

  test("the overview model chart includes Codex GPT models", async ({ page }) => {
    await page.goto("/overview");
    // Codex GPT models land in the same per-model cost breakdown as Claude
    const modelChart = page.locator(".chart-card", { hasText: "Cost by model" });
    await expect(modelChart).toBeVisible();
    await expect(modelChart).toContainText(/gpt-5/i);
  });

  test("Codex skill use (reading a SKILL.md) is surfaced as a skill event", async ({
    page,
  }) => {
    // a Codex session that used the openai-docs skill by reading its SKILL.md.
    // Codex has no skill tool, so this is detected from the shell read — it must
    // still show up as a first-class skill (it was previously lost as a file_read).
    await page.goto("/?session=019e9d30-e0a9-7752-b11c-70aa8644e17f&tab=skills");
    await expect(page.locator(".timeline .event-icon.skill").first()).toBeVisible();
    await expect(page.locator(".timeline")).toContainText(/openai-docs/);
  });
});

test.describe("Transcript ⇄ Git cross-links", () => {
  // an edit-heavy Claude session, so attributed hunks definitely exist
  const SID = "144d8b23-cb28-4208-9b0c-98dfa585a741";

  test("an edit jumps to its diff, and the diff jumps back to the producing step", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}`);
    await expandAllTurns(page);
    // select a file-edit step in the transcript
    const editRow = page
      .locator(".event-row")
      .filter({ has: page.locator(".event-icon.file_edit") })
      .first();
    await expect(editRow).toBeVisible();
    await editRow.click();
    // its detail panel offers a jump to the Git diff this edit produced
    const diffBtn = page.locator(".detail-actions .btn", { hasText: /Diff/ });
    await expect(diffBtn).toBeVisible();
    await diffBtn.click();
    // now on the Git tab, diff embedded, with a linked-event back-link
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Git/);
    await expect(page.locator(".diff-embed")).toBeVisible();
    const back = page.locator(".le-jump").first();
    await expect(back).toBeVisible();
    // the back-link returns to the transcript with an event selected
    await back.click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
    await expect(page.locator(".event-row.selected")).toHaveCount(1);
  });
});

test.describe("Turn-first explorer", () => {
  const SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";
  const SUBAGENT_SID = "da2ac032-a905-4267-8e5f-851456926a79";

  test("initial transcript view shows turn headers only", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    await expect(page.locator(".timeline .event-row.turn-header").first()).toBeVisible();
    await expect.poll(async () => page.locator(".timeline .event-row.step-row").count()).toBe(0);
  });

  test("turn headers show rollup values from the real session data", async ({ page }) => {
    const first = (await getTurnExpectations(SID))[0];
    await page.goto(`/?session=${SID}`);
    const row = page.locator(`.timeline .event-row.turn-header[data-turn="${first.turn}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-rollup-steps", String(first.steps));
    await expect(row).toHaveAttribute("data-rollup-edits", String(first.edits));
    await expect(row).toHaveAttribute("data-rollup-errors", String(first.errors));
    await expect(row).toHaveAttribute("data-rollup-files", String(first.files.length));
    await expect(row).toContainText(`${first.steps} step`);
    await expect(row).toContainText(`${first.edits} edits`);
    await expect(row).toContainText(`${first.errors} errors`);
    await expect(row).toContainText(fmtCostForTest(first.costUsd));
    await expect(row).toContainText(fmtCompactForTest(first.tokens));
    await expect(row).toContainText(humanizeDurationForTest(first.durationMs));
    await expect(row).toContainText(`${first.files.length} files`);
  });

  test("turns with errors carry the error emphasis hook", async ({ page }) => {
    const errorTurn = (await getTurnExpectations(SID)).find((t) => t.errors > 0);
    expect(errorTurn).toBeTruthy();
    await page.goto(`/?session=${SID}`);
    const row = page.locator(`.timeline .event-row.turn-header[data-turn="${errorTurn!.turn}"]`);
    await expect(row).toHaveAttribute("data-turn-has-error", "true");
    await expect(row).toHaveClass(/turn-has-error/);
  });

  test("turn row click expands and collapses; sub-agent nesting still expands", async ({ page }) => {
    await page.goto(`/?session=${SUBAGENT_SID}`);
    const firstHeader = page.locator(".timeline .event-row.turn-header").first();
    await firstHeader.click();
    await expect.poll(async () => page.locator(".timeline .event-row.step-row").count()).toBeGreaterThan(0);
    await firstHeader.click();
    await expect.poll(async () => page.locator(".timeline .event-row.step-row").count()).toBe(0);

    await expandAllTurns(page);
    const saExpander = page
      .locator(".event-row.step-row:not(.turn-header)")
      .filter({ has: page.locator(".event-icon.subagent") })
      .first()
      .locator(".tw-expand");
    if ((await saExpander.count()) > 0) {
      await saExpander.click();
      await expect
        .poll(async () => page.locator(".timeline .event-row.child-row").count())
        .toBeGreaterThan(0);
    }
  });

  test("expanded step rows expose proportional time bars", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    await expandAllTurns(page);
    const bars = page.locator(".timeline .event-row.step-row .step-timebar");
    await expect(bars.first()).toBeVisible();
    const values = await bars.evaluateAll((els) =>
      els
        .map((el) => ({
          duration: Number((el as HTMLElement).dataset.durationMs || 0),
          width: Number((el as HTMLElement).dataset.widthPct || 0),
        }))
        .filter((v) => v.duration > 0)
    );
    expect(values.length).toBeGreaterThan(0);
    const shortest = values.reduce((a, b) => (a.duration <= b.duration ? a : b));
    const longest = values.reduce((a, b) => (a.duration >= b.duration ? a : b));
    expect(longest.width).toBeGreaterThanOrEqual(shortest.width);
  });

  test("turn files chip opens the active diff file; touched steps jump back", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    const chip = page.locator(".timeline .turn-files-chip").first();
    await expect(chip).toBeVisible();
    const fileId = await chip.getAttribute("data-file-id");
    expect(fileId).toBeTruthy();
    await chip.click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Git/);
    await expect(page.locator(`.file-row.active[data-file-id="${fileId}"]`)).toBeVisible();
    await expect(page.locator(".file-touched-steps")).toBeVisible();
    await page.locator(".file-touched-step").first().click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
    await expect(page.locator(".timeline .event-row.selected")).toHaveCount(1);
  });

  test("event type filters can highlight or hide non-matching steps", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    await expandAllTurns(page);
    await page.locator(".filter-mode button", { hasText: "Highlight" }).click();
    await page.locator(".filters .event-type-badge.bash").click();
    await expect
      .poll(async () => page.locator(".timeline .event-row.step-row.filter-dimmed").count())
      .toBeGreaterThan(0);
    expect(await page.locator(".timeline .event-row.step-row .event-icon.bash").count()).toBeGreaterThan(0);
    await page.locator(".filter-mode button", { hasText: "Hide" }).click();
    await expect.poll(async () => page.locator(".timeline .event-row.step-row .event-icon.bash").count()).toBe(0);
  });
});

test.describe("Transcript: turn grouping", () => {
  // multi-turn Claude session (41 turns) — Collapse turns must reduce the row
  // count to exactly the turn-header count, Expand turns must restore them.
  const SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";

  test("turn headers carry the Turn N · M steps chip", async ({ page }) => {
    const first = (await getTurnExpectations(SID))[0];
    await page.goto(`/?session=${SID}`);
    await expect(page.locator(".event-row.turn-header").first()).toBeVisible();
    await expect(page.locator(".chip.turn-chip").first()).toContainText(/Turn 1\b/);
    await expect(page.locator(".event-row.turn-header").first()).toContainText(`${first.steps} step`);
  });

  test("Expand turns restores step rows; Collapse turns returns to turn headers only", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    const headers = await page.locator(".event-row.turn-header").count();
    expect(headers).toBeGreaterThan(1);
    await expect.poll(async () => page.locator(".event-row").count()).toBe(headers);
    await page.locator(".turn-filter button", { hasText: "Expand turns" }).click();
    await expect
      .poll(async () => page.locator(".event-row").count())
      .toBeGreaterThan(headers);
    await page.locator(".turn-filter button", { hasText: "Collapse turns" }).click();
    await expect.poll(async () => page.locator(".event-row").count()).toBe(headers);
  });
});

test.describe("Git diff: step focus", () => {
  // a session whose primary changed file has hunks from multiple turns
  const SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";

  test("other turns' hunks collapse; All changes expands; This step re-collapses", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=git`);
    // by default the selected step's hunk is expanded; other turns collapse
    await expect(page.locator(".diff-hunk.collapsed").first()).toBeVisible();
    expect(await page.locator(".diff-hunk.collapsed").count()).toBeGreaterThan(0);
    await expect(page.locator(".step-filter")).toBeVisible();
    // "All changes" expands every hunk
    await page.locator(".step-filter button", { hasText: "All changes" }).click();
    await expect.poll(async () => page.locator(".diff-hunk.collapsed").count()).toBe(0);
    // "This step" collapses other turns again
    await page.locator(".step-filter button", { hasText: "This step" }).click();
    await expect.poll(async () => page.locator(".diff-hunk.collapsed").count()).toBeGreaterThan(0);
  });
});
