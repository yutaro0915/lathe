import { test, expect, type Page } from "@playwright/test";
export { test, expect };
import { readdirSync, readFileSync, statSync } from "node:fs";
export { readdirSync, readFileSync, statSync };
import { join, resolve } from "node:path";
export { join, resolve };

// The e2e seed*/cleanup* fixture machinery and the scratch-Postgres primitives
// (DATABASE_URL / withDb / Client / COST_ANOMALY_BASELINE) live in ./fixtures so
// each file stays under the file-size gate (I4). Re-export them here so existing
// `import { … } from "./helpers"` sites keep resolving every symbol unchanged.
export * from "./fixtures";
import { Client, DATABASE_URL, withDb } from "./fixtures";

export type DbSession = { cost_usd: number | null; token_usage: number };
export type DbEvent = {
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
export type DbFileLink = { event_id: string; file_id: string; path: string };
export type TurnExpectation = {
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

export const turnCache = new Map<string, Promise<TurnExpectation[]>>();

// ---- IA helper (DS v1 shell) ----------------------------------------------
// The bare "/" route is now the cross-session Sessions LIST surface (full-width
// in the work area; the left is navigation only). The per-session WORKSPACE
// (transcript / tabs / ribbon / detail) lives at "/?session=<id>". These helpers
// open the workspace from the list — preserving each workspace test's oracle
// (it still drives the viewer), only the entry URL changed from "/" to a row.
export async function firstSessionId(page: Page): Promise<string> {
  await expect(page.locator(`[data-testid="session-list"] [data-testid="session-item"]`).first()).toBeVisible();
  const id = await page
    .locator(`[data-testid="session-list"] [data-testid="session-item"]`)
    .first()
    .getAttribute("data-session-id");
  if (!id) throw new Error("no session row found on the Sessions surface");
  return id;
}
// Open the workspace on the most-recent session (optionally on a given ?tab=…).
// Use where a test previously did goto("/") and then drove the viewer.
export async function gotoViewer(page: Page, query = ""): Promise<string> {
  await page.goto("/");
  const id = await firstSessionId(page);
  const sep = query ? `&${query}` : "";
  await page.goto(`/?session=${encodeURIComponent(id)}${sep}`);
  return id;
}

export function fmtCompactForTest(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function fmtCostForTest(c: number | null): string {
  if (c == null || !Number.isFinite(c) || c < 0) return "—";
  if (c > 0 && c < 0.01) return "<$0.01";
  return `$${c.toFixed(2)}`;
}

export function humanizeDurationForTest(ms: number | null): string {
  if (ms == null) return "—";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function hmsToMsForTest(ts: string): number | null {
  const m = /(\d{2}):(\d{2}):(\d{2})/.exec(ts);
  if (!m) return null;
  return (Number(m[1]) * 60 * 60 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

export function readMetaCostForTest(e: DbEvent): number | null {
  if (!e.meta) return null;
  try {
    const meta = JSON.parse(e.meta);
    return typeof meta.costUsd === "number" ? meta.costUsd : null;
  } catch {
    return null;
  }
}

export async function getTurnExpectations(sessionId: string): Promise<TurnExpectation[]> {
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

export function highestCostTurn(turns: TurnExpectation[]): TurnExpectation {
  const candidates = turns.filter((t) => t.steps > 0 && t.costUsd != null);
  return candidates.sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || a.turn - b.turn)[0];
}

export function longestWallDurationTurn(turns: TurnExpectation[]): TurnExpectation {
  const candidates = turns.filter((t) => t.steps > 0);
  return candidates.sort((a, b) => b.wallDurationMs - a.wallDurationMs || a.turn - b.turn)[0];
}

export async function findCompactCodexSession(): Promise<string> {
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

export async function findMultiFileDiffSession(): Promise<string> {
  const row = await withDb(async (client) =>
    (
      await client.query<{ id: string }>(
        `SELECT s.id
           FROM sessions s
           JOIN changed_files cf ON cf.session_id = s.id
          GROUP BY s.id, s.seq, s.started_at
         HAVING COUNT(DISTINCT cf.path) > 1
          ORDER BY s.seq DESC NULLS LAST, s.started_at DESC NULLS LAST
          LIMIT 1`
      )
    ).rows[0]
  );
  if (!row) throw new Error("No session with multiple changed files");
  return row.id;
}

export async function expectTurnJump(
  page: Page,
  sessionId: string,
  buttonText: string,
  targetTurn: TurnExpectation,
  expectedBasis?: "cost" | "duration"
) {
  await page.goto(`/?session=${sessionId}`);
  const jump = page.locator(`[data-testid="sessbar"] [data-testid="chip"][data-jump-kind]`, { hasText: buttonText });
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAttribute("data-turn", String(targetTurn.turn));
  if (expectedBasis) await expect(jump).toHaveAttribute("data-turn-score-basis", expectedBasis);
  await jump.click();
  const header = page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="turn-header"][data-turn="${targetTurn.turn}"]`);
  await expect(header).toHaveAttribute("data-selected", "true");
  await expect(
    page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"][data-turn="${targetTurn.turn}"]`).first()
  ).toBeVisible();
}

export async function expandAllTurns(page: Page) {
  const expand = page.locator(`[data-testid="turn-filter"] button`, { hasText: "Expand turns" });
  if ((await expand.count()) > 0) await expand.click();
}
