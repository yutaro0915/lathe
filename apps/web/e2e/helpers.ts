import { test, expect, type Page } from "@playwright/test";
export { test, expect };
import { Client } from "pg";
export { Client };
import { readdirSync, readFileSync, statSync } from "node:fs";
export { readdirSync, readFileSync, statSync };
import { join, resolve } from "node:path";
export { join, resolve };
import { COST_ANOMALY_BASELINE } from "@lathe/shared";
export { COST_ANOMALY_BASELINE };

export const DATABASE_URL = process.env.DATABASE_URL || "postgres://lathe:lathe@localhost:55432/lathe";

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
export type CostAnomalyExpectation = {
  session_id: string;
  parent_session_id: string | null;
  runner: string;
  cost_usd: number | null;
  cost_anomaly_group_size: number;
  cost_anomaly_group_median_usd: number | null;
  cost_anomaly_threshold_usd: number;
  cost_anomaly: boolean;
};
export type FindingOracle = {
  pending_count: number;
  id: number;
  analyst: string;
  kind: string;
  evidence_count: number;
};

export const turnCache = new Map<string, Promise<TurnExpectation[]>>();
export const COST_FIXTURE_IDS = [
  "e2e-cost-fallback-low",
  "e2e-cost-fallback-high",
  "e2e-cost-fallback-null",
] as const;
export const COST_FIXTURE_PROJECT_ID = "fixture:g9-cost-anomaly";

export const PR_FIXTURE = {
  projectId: "fixture:g1-pr-linkage",
  prId: "fixture:g1-pr-linkage#1",
  shaSession: "fixture-sha-session",
  branchSession: "fixture-branch-session",
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  shaPrefix: "aaaaaaa",
  branch: "feature/g1-pr-linkage-fixture",
};

export const FINDING_FIXTURE = {
  projectId: "fixture:s2-finding-ui",
  sessionId: "fixture-finding-ui-session",
  otherSessionId: "fixture-finding-ui-other-session",
  harnessId: "fixture-finding-ui-harness",
  eventId: "fixture-finding-ui-session-event-2",
  fileId: "fixture-finding-ui-file-1",
  hunkId: "fixture-finding-ui-hunk-1",
  path: "/tmp/lathe-finding-ui/src/app.ts",
  titles: {
    jump: "Fixture failure loop pending",
    verdict: "Fixture excess cost pending",
    decided: "Fixture risky action accepted",
    // exercises the analyst's real contract: subjectKind="turn" with a
    // locator of { seq } where seq is an EVENT seq (the bug that used to leave
    // these unresolved). Its evidence excerpt must surface the seq-2 command.
    turnSeq: "Fixture turn-seq locator pending",
    // multiple evidence rows in the SAME (session, turn) — must collapse into ONE
    // group card with one step row per seq (requirement B). Mirrors real finding
    // #113 (ripgrep, 4 same-turn evidence).
    grouped: "Fixture repeated same-turn pending",
    // a finding whose evidence excerpt is ONE very long, unbroken single-line
    // command (no wrap opportunities). It must be absorbed by per-pane horizontal
    // scroll, never widen the grid / page, never silently truncate (the
    // left-blank / horizontal-shift regression). Mirrors real finding #113's
    // 140-char `rg -n …` one-liner, exaggerated.
    longLine: "Fixture long no-wrap command pending",
  },
  // a single-line command with NO break opportunities (one unbroken token chain)
  // — the worst case for layout: must scroll inside the excerpt pane, not wrap or
  // overflow the page.
  longCommand:
    "rg -n '5650964812|D2nyYVK3zbYKii' " +
    "projects/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/" +
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/" +
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc.md",
};

export const SUBAGENT_FIXTURE = {
  projectId: "fixture:subagent-session-linking",
  parentId: "fixture-subagent-parent-session",
  childId: "fixture-subagent-child-session",
  missingAgentId: "fixture-subagent-missing-session",
  linkedLauncherId: "fixture-subagent-parent-session-event-2",
  unlinkedLauncherId: "fixture-subagent-parent-session-event-3",
};

// ---- IA helper (DS v1 shell) ----------------------------------------------
// The bare "/" route is now the cross-session Sessions LIST surface (full-width
// in the work area; the left is navigation only). The per-session WORKSPACE
// (transcript / tabs / ribbon / detail) lives at "/?session=<id>". These helpers
// open the workspace from the list — preserving each workspace test's oracle
// (it still drives the viewer), only the entry URL changed from "/" to a row.
export async function firstSessionId(page: Page): Promise<string> {
  await expect(page.locator(`[data-testid="session-list"] [class~="session-item"]`).first()).toBeVisible();
  const id = await page
    .locator(`[data-testid="session-list"] [class~="session-item"]`)
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

export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function cleanupFindingFixtures() {
  await withDb(async (client) => {
    await client.query(
      `DELETE FROM finding_verdicts
        USING findings
       WHERE finding_verdicts.finding_id = findings.id
         AND findings.project_id = $1`,
      [FINDING_FIXTURE.projectId]
    );
    await client.query(
      `DELETE FROM finding_evidence
        USING findings
       WHERE finding_evidence.finding_id = findings.id
         AND findings.project_id = $1`,
      [FINDING_FIXTURE.projectId]
    );
    await client.query("DELETE FROM findings WHERE project_id = $1", [FINDING_FIXTURE.projectId]);
    await client.query("DELETE FROM attributions WHERE hunk_id = $1", [FINDING_FIXTURE.hunkId]);
    await client.query("DELETE FROM diff_hunks WHERE id = $1", [FINDING_FIXTURE.hunkId]);
    await client.query("DELETE FROM changed_files WHERE id = $1", [FINDING_FIXTURE.fileId]);
    await client.query("DELETE FROM event_files WHERE event_id = $1", [FINDING_FIXTURE.eventId]);
    await client.query("DELETE FROM transcript_events WHERE session_id IN ($1,$2)", [
      FINDING_FIXTURE.sessionId,
      FINDING_FIXTURE.otherSessionId,
    ]);
    await client.query("DELETE FROM sessions WHERE id IN ($1,$2)", [
      FINDING_FIXTURE.sessionId,
      FINDING_FIXTURE.otherSessionId,
    ]);
    await client.query("DELETE FROM harness_versions WHERE id = $1", [FINDING_FIXTURE.harnessId]);
    await client.query("DELETE FROM projects WHERE id = $1", [FINDING_FIXTURE.projectId]);
  });
}

export async function cleanupSubagentFixtures() {
  await withDb(async (client) => {
    await client.query("DELETE FROM transcript_events WHERE session_id IN ($1,$2)", [
      SUBAGENT_FIXTURE.parentId,
      SUBAGENT_FIXTURE.childId,
    ]);
    await client.query("DELETE FROM sessions WHERE id IN ($1,$2)", [
      SUBAGENT_FIXTURE.childId,
      SUBAGENT_FIXTURE.parentId,
    ]);
    await client.query("DELETE FROM projects WHERE id = $1", [SUBAGENT_FIXTURE.projectId]);
  });
}

export async function seedSubagentFixtures() {
  await cleanupSubagentFixtures();
  await withDb(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO projects (id,display_name,git_remote,cwd_hint) VALUES ($1,$2,$3,$4)",
        [
          SUBAGENT_FIXTURE.projectId,
          "Sub-agent Session Linking Fixture",
          "https://github.com/lathe-fixture/subagent-session-linking.git",
          "/tmp/lathe-subagent-linking",
        ]
      );
      await client.query(
        `INSERT INTO sessions (
           id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,
           edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,
           cost_usd,summary,seq
         )
         VALUES ($1,$2,'Sub-agent Session Linking Fixture','Fixture parent with sub-agent links','codex','gpt-5.3-codex','done',
           '2026-06-12 02:00:00','2026-06-12 02:00:10',10000,1,2,0,0,2,0,120,70,50,
           'loop/19-subagent-linking',0,0.03,'fixture parent',930019)`,
        [SUBAGENT_FIXTURE.parentId, SUBAGENT_FIXTURE.projectId]
      );
      await client.query(
        `INSERT INTO sessions (
           id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,
           edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,
           cost_usd,summary,parent_session_id,spawned_by_seq,seq
         )
         VALUES ($1,$2,'Sub-agent Session Linking Fixture','Fixture linked sub-session','codex','gpt-5.3-codex-spark','done',
           '2026-06-12 02:00:02','2026-06-12 02:00:07',5000,1,2,0,1,0,0,333,222,111,
           'loop/19-subagent-linking',0,0.13,'fixture child',$3,2,930020)`,
        [SUBAGENT_FIXTURE.childId, SUBAGENT_FIXTURE.projectId, SUBAGENT_FIXTURE.parentId]
      );
      await client.query(
        `INSERT INTO transcript_events
          (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
         VALUES
          ($1,$2,1,'02:00:00','user_message','user','Fixture parent prompt','Spawn fixture sub-agents.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($3,$2,2,'02:00:01','subagent','assistant','Sub-agent · explorer','Linked fixture subagent task',NULL,NULL,NULL,5000,NULL,'explorer',$4::jsonb,NULL),
          ($5,$2,3,'02:00:08','subagent','assistant','Sub-agent · explorer','Missing fixture subagent task',NULL,NULL,NULL,NULL,NULL,'explorer',$6::jsonb,NULL)`,
        [
          `${SUBAGENT_FIXTURE.parentId}-event-1`,
          SUBAGENT_FIXTURE.parentId,
          SUBAGENT_FIXTURE.linkedLauncherId,
          JSON.stringify({
            tool: "spawn_agent",
            agent_id: SUBAGENT_FIXTURE.childId,
            child_session_id: SUBAGENT_FIXTURE.childId,
            nickname: "FixtureLinked",
          }),
          SUBAGENT_FIXTURE.unlinkedLauncherId,
          JSON.stringify({
            tool: "spawn_agent",
            agent_id: SUBAGENT_FIXTURE.missingAgentId,
            nickname: "FixtureMissing",
          }),
        ]
      );
      await client.query(
        `INSERT INTO transcript_events
          (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
         VALUES
          ($1,$2,1,'02:00:02','user_message','user','Fixture child prompt','Inspect linked child work.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($3,$2,2,'02:00:03','bash','assistant','Fixture child command','child command output',NULL,'pnpm test',0,1500,123,NULL,$4::jsonb,NULL),
          ($5,$2,3,'02:00:05','assistant_message','assistant','Fixture child summary','Child session completed.',NULL,NULL,NULL,500,210,NULL,NULL,NULL)`,
        [
          `${SUBAGENT_FIXTURE.childId}-event-1`,
          SUBAGENT_FIXTURE.childId,
          `${SUBAGENT_FIXTURE.childId}-event-2`,
          JSON.stringify({ tool: "exec_command" }),
          `${SUBAGENT_FIXTURE.childId}-event-3`,
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function seedFindingFixtures() {
  await cleanupFindingFixtures();
  await withDb(async (client) => {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO projects (id,display_name,git_remote,cwd_hint) VALUES ($1,$2,$3,$4)",
        [
          FINDING_FIXTURE.projectId,
          "S2 Finding UI Fixture",
          "https://github.com/lathe-fixture/finding-ui.git",
          "/tmp/lathe-finding-ui",
        ]
      );
      await client.query(
        `INSERT INTO harness_versions (id,project_id,provider,content_hash,git_commit)
         VALUES ($1,$2,'codex','fixture-finding-ui-hash','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')`,
        [FINDING_FIXTURE.harnessId, FINDING_FIXTURE.projectId]
      );
      await client.query(
        `INSERT INTO sessions (
           id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,
           edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,
           cost_usd,summary,harness_version_id,seq
         )
         VALUES ($1,$2,'S2 Finding UI Fixture','Fixture findings session','codex','<synthetic>','done',
           '2026-06-12 00:00:00','2026-06-12 00:00:03',3000,1,1,1,1,0,1,100,60,40,
           'loop/17-finding-ui',0,0.02,'fixture',$3,910017)`,
        [FINDING_FIXTURE.sessionId, FINDING_FIXTURE.projectId, FINDING_FIXTURE.harnessId]
      );
      await client.query(
        `INSERT INTO transcript_events
          (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
         VALUES
          ($1,$2,1,'00:00:00','user_message','user','Fixture prompt','Please inspect the fixture.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($3,$2,2,'00:00:01','bash','assistant','Fixture failed command','exit 1 from fixture',NULL,'pnpm test',1,1200,80,NULL,NULL,NULL),
          ($4,$2,3,'00:00:03','assistant_message','assistant','Fixture summary','The fixture command failed once.',NULL,NULL,NULL,300,20,NULL,NULL,NULL),
          ($5,$2,4,'00:00:04','bash','assistant','Fixture long command','exit 1 from a long one-liner',NULL,$6,1,900,40,NULL,NULL,NULL)`,
        [
          `${FINDING_FIXTURE.sessionId}-event-1`,
          FINDING_FIXTURE.sessionId,
          FINDING_FIXTURE.eventId,
          `${FINDING_FIXTURE.sessionId}-event-3`,
          `${FINDING_FIXTURE.sessionId}-event-4`,
          FINDING_FIXTURE.longCommand,
        ]
      );
      await client.query(
        `INSERT INTO sessions (
           id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,
           edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,
           cost_usd,summary,harness_version_id,seq
         )
         VALUES ($1,$2,'S2 Finding UI Fixture','Fixture other findings session','codex','<synthetic>','done',
           '2026-06-12 00:10:00','2026-06-12 00:10:03',3000,1,1,0,1,0,0,50,30,20,
           'loop/17-finding-ui',0,0.01,'fixture other',$3,910018)`,
        [FINDING_FIXTURE.otherSessionId, FINDING_FIXTURE.projectId, FINDING_FIXTURE.harnessId]
      );
      await client.query(
        `INSERT INTO transcript_events
          (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
         VALUES
          ($1,$2,1,'00:10:00','user_message','user','Fixture other prompt','Please inspect the other fixture.',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
          ($3,$2,2,'00:10:01','bash','assistant','Fixture other command','other fixture output',NULL,'pnpm lint',0,800,50,NULL,NULL,NULL)`,
        [
          `${FINDING_FIXTURE.otherSessionId}-event-1`,
          FINDING_FIXTURE.otherSessionId,
          `${FINDING_FIXTURE.otherSessionId}-event-2`,
        ]
      );
      await client.query(
        `INSERT INTO changed_files (id,session_id,path,status,additions,deletions,language,seq)
         VALUES ($1,$2,$3,'modified',1,1,'ts',1)`,
        [FINDING_FIXTURE.fileId, FINDING_FIXTURE.sessionId, FINDING_FIXTURE.path]
      );
      await client.query(
        `INSERT INTO diff_hunks (id,file_id,seq,header,content)
         VALUES ($1,$2,1,'@@ -1,3 +1,3 @@',$3)`,
        [
          FINDING_FIXTURE.hunkId,
          FINDING_FIXTURE.fileId,
          " const ok = true;\n-console.log('old');\n+console.log('new');",
        ]
      );
      await client.query(
        `INSERT INTO attributions (id,hunk_id,event_id,confidence,method,note)
         VALUES ($1,$2,$3,'high','shell_inferred','fixture hunk attribution')`,
        [`${FINDING_FIXTURE.hunkId}-attr`, FINDING_FIXTURE.hunkId, FINDING_FIXTURE.eventId]
      );
      await client.query(
        `INSERT INTO event_files (event_id,path,role)
         VALUES ($1,$2,'edit')`,
        [FINDING_FIXTURE.eventId, FINDING_FIXTURE.path]
      );

      const jumpFinding = (
        await client.query<{ id: number }>(
          `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id)
           VALUES ('rules-v1','failure_loop',$1,'Repeated failing command in a single turn.',0.92,$2,$3)
           RETURNING id`,
          [FINDING_FIXTURE.titles.jump, FINDING_FIXTURE.harnessId, FINDING_FIXTURE.projectId]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,subject_id,note)
         VALUES
          ($1,'event',$2,$3::jsonb,$4,'failed command step'),
          ($1,'hunk',$2,$5::jsonb,$6,'diff hunk from the failed step')`,
        [
          jumpFinding,
          FINDING_FIXTURE.sessionId,
          JSON.stringify({ seq: 2 }),
          FINDING_FIXTURE.eventId,
          JSON.stringify({ path: FINDING_FIXTURE.path, hunk_seq: 1 }),
          FINDING_FIXTURE.hunkId,
        ]
      );

      const verdictFinding = (
        await client.query<{ id: number }>(
          `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id)
           VALUES ('llm-v1','excess_cost',$1,'Token cost crossed the review threshold.',0.81,$2,$3)
           RETURNING id`,
          [FINDING_FIXTURE.titles.verdict, FINDING_FIXTURE.harnessId, FINDING_FIXTURE.projectId]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,subject_id,note)
         VALUES ($1,'turn',$2,$3::jsonb,NULL,'turn-level cost signal')`,
        [verdictFinding, FINDING_FIXTURE.sessionId, JSON.stringify({ turn: 1 })]
      );

      // turn-kind evidence whose locator is { seq: <event seq> } — the exact
      // shape analyst-engine.ts writes. Before the fix this resolved to nothing.
      const turnSeqFinding = (
        await client.query<{ id: number }>(
          `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id)
           VALUES ('rules-v1','failure_loop',$1,'Repeated failed command pattern (turn-seq locator).',0.7,$2,$3)
           RETURNING id`,
          [FINDING_FIXTURE.titles.turnSeq, FINDING_FIXTURE.harnessId, FINDING_FIXTURE.projectId]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,subject_id,note)
         VALUES ($1,'turn',$2,$3::jsonb,NULL,'first failed command in repeated pattern')`,
        [turnSeqFinding, FINDING_FIXTURE.sessionId, JSON.stringify({ seq: 2 })]
      );

      // a finding whose evidence repeats within ONE turn: two `turn` rows at
      // seqs 2 and 3 (both turn 1 in the fixture session). These must fold into a
      // single group card with two STEP rows (requirement B).
      const groupedFinding = (
        await client.query<{ id: number }>(
          `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id)
           VALUES ('rules-v1','failure_loop',$1,'Same instruction repeated within one turn.',0.66,$2,$3)
           RETURNING id`,
          [FINDING_FIXTURE.titles.grouped, FINDING_FIXTURE.harnessId, FINDING_FIXTURE.projectId]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,subject_id,note)
         VALUES
          ($1,'turn',$2,$3::jsonb,NULL,'first occurrence'),
          ($1,'turn',$2,$4::jsonb,NULL,'second occurrence')`,
        [
          groupedFinding,
          FINDING_FIXTURE.sessionId,
          JSON.stringify({ seq: 2 }),
          JSON.stringify({ seq: 3 }),
        ]
      );

      // a finding whose single evidence excerpt is the long one-liner (seq 4).
      // The excerpt command must scroll horizontally inside its pane — it must
      // never widen the detail grid or push the page (left-blank regression).
      const longLineFinding = (
        await client.query<{ id: number }>(
          `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id)
           VALUES ('hybrid-v1','failure_loop',$1,'Repeated long single-line command.',0.6,$2,$3)
           RETURNING id`,
          [FINDING_FIXTURE.titles.longLine, FINDING_FIXTURE.harnessId, FINDING_FIXTURE.projectId]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,subject_id,note)
         VALUES ($1,'turn',$2,$3::jsonb,NULL,'long one-liner step')`,
        [longLineFinding, FINDING_FIXTURE.sessionId, JSON.stringify({ seq: 4 })]
      );

      const decidedFinding = (
        await client.query<{ id: number }>(
          `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id)
           VALUES ('hybrid-v1','risky_action',$1,'Fixture decided finding.',0.44,$2,$3)
           RETURNING id`,
          [FINDING_FIXTURE.titles.decided, FINDING_FIXTURE.harnessId, FINDING_FIXTURE.projectId]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,subject_id,note)
         VALUES ($1,'session',$2,$3::jsonb,$2,'session-level evidence')`,
        [decidedFinding, FINDING_FIXTURE.sessionId, JSON.stringify({ session_id: FINDING_FIXTURE.sessionId })]
      );
      await client.query(
        `INSERT INTO finding_verdicts (finding_id,verdict,reason,decided_by)
         VALUES ($1,'accept','fixture pre-decided','user')`,
        [decidedFinding]
      );

      const otherFinding = (
        await client.query<{ id: number }>(
          `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id)
           VALUES ('rules-v1','risky_action','Fixture other session pending','Separate pending finding for scoping negative cases.',0.61,$1,$2)
           RETURNING id`,
          [FINDING_FIXTURE.harnessId, FINDING_FIXTURE.projectId]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,subject_id,note)
         VALUES ($1,'event',$2,$3::jsonb,$4,'other session evidence')`,
        [
          otherFinding,
          FINDING_FIXTURE.otherSessionId,
          JSON.stringify({ seq: 2 }),
          `${FINDING_FIXTURE.otherSessionId}-event-2`,
        ]
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function getFindingOracle(title = FINDING_FIXTURE.titles.jump): Promise<FindingOracle> {
  return withDb(async (client) => {
    const row = (
      await client.query<FindingOracle>(
        `WITH latest_verdict AS (
           SELECT DISTINCT ON (finding_id) finding_id, id
             FROM finding_verdicts
            ORDER BY finding_id, decided_at DESC, id DESC
         ),
         pending AS (
           SELECT COUNT(*)::int AS pending_count
             FROM findings f
             LEFT JOIN latest_verdict v ON v.finding_id = f.id
            WHERE v.id IS NULL
         )
         SELECT (SELECT pending_count FROM pending) AS pending_count,
                f.id,
                f.analyst,
                f.kind,
                COUNT(fe.id)::int AS evidence_count
           FROM findings f
           LEFT JOIN finding_evidence fe ON fe.finding_id = f.id
          WHERE f.title = $1
          GROUP BY f.id, f.analyst, f.kind`,
        [title]
      )
    ).rows[0];
    if (!row) throw new Error(`finding oracle missing for ${title}`);
    return row;
  });
}

// pending findings ATTACHED to one session — the session viewer's Findings tab
// is session-scoped (IA principle 2026-06-12), so its badge counts these, not
// the project-wide pending total.
export async function pendingFindingsForSession(sessionId: string): Promise<number> {
  return withDb(async (client) => {
    const row = (
      await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM findings f
          WHERE EXISTS (
                  SELECT 1 FROM finding_evidence fe
                   WHERE fe.finding_id = f.id AND fe.session_id = $1)
            AND NOT EXISTS (
                  SELECT 1 FROM finding_verdicts v WHERE v.finding_id = f.id)`,
        [sessionId],
      )
    ).rows[0];
    return row?.n ?? 0;
  });
}

export async function verdictCountForFinding(title: string): Promise<number> {
  return withDb(async (client) => {
    const row = (
      await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n
           FROM finding_verdicts fv
           JOIN findings f ON f.id = fv.finding_id
          WHERE f.title = $1`,
        [title]
      )
    ).rows[0];
    return row?.n ?? 0;
  });
}

export async function seedCostFallbackFixtures() {
  const { absoluteFloorUsd } = COST_ANOMALY_BASELINE;
  await withDb(async (client) => {
    await client.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [COST_FIXTURE_IDS]);
    await client.query(
      `INSERT INTO projects (id,display_name,git_remote,cwd_hint)
       VALUES ($1,'G9 Cost Anomaly Fixture',NULL,NULL)
       ON CONFLICT (id) DO UPDATE
          SET display_name = EXCLUDED.display_name,
              updated_at = CURRENT_TIMESTAMP`,
      [COST_FIXTURE_PROJECT_ID]
    );
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
           id, project_id, project, title, runner, model, status, started_at, ended_at, duration_ms,
           turn_count, tool_count, edit_count, bash_count, subagent_count, error_count,
           token_usage, token_in, token_out, git_branch, commit_count, cost_usd, summary, seq
         ) VALUES (
           $1, $2, 'LLMWiki', $3, 'cursor', 'e2e-cost-baseline', 'done',
           '2026-06-11 00:00:00', '2026-06-11 00:00:01', 1000,
           1, 0, 0, 0, 0, 0,
           0, 0, 0, 'loop/12-g9-cost-anomaly', 0, $4, NULL, $5
         )`,
        [r.id, COST_FIXTURE_PROJECT_ID, r.title, r.cost, r.seq]
      );
    }
  });
}

export async function cleanupCostFallbackFixtures() {
  await withDb(async (client) => {
    await client.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [COST_FIXTURE_IDS]);
    await client.query("DELETE FROM projects WHERE id = $1", [COST_FIXTURE_PROJECT_ID]);
  });
}

export async function getCostAnomalyExpectations(
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
                s.parent_session_id,
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
  const jump = page.locator(`[data-testid="sessbar"] [class~="jump-chip"]`, { hasText: buttonText });
  await expect(jump).toBeVisible();
  await expect(jump).toHaveAttribute("data-turn", String(targetTurn.turn));
  if (expectedBasis) await expect(jump).toHaveAttribute("data-turn-score-basis", expectedBasis);
  await jump.click();
  const header = page.locator(`[data-testid="timeline"] [class~="event-row"][class~="turn-header"][data-turn="${targetTurn.turn}"]`);
  await expect(header).toHaveClass(/selected/);
  await expect(
    page.locator(`[data-testid="timeline"] [class~="event-row"][class~="step-row"][data-turn="${targetTurn.turn}"]`).first()
  ).toBeVisible();
}

export async function findScopingOracle(): Promise<{
  findingId: number;
  title: string;
  ownerSession: string;
  otherSession: string;
}> {
  return withDb(async (client) => {
    const single = (
      await client.query<{ finding_id: number; title: string; session_id: string }>(
        `SELECT finding_id, title, session_id FROM (
           SELECT fe.finding_id, f.title, MIN(fe.session_id) AS session_id,
                  COUNT(DISTINCT fe.session_id) AS n
             FROM finding_evidence fe
             JOIN findings f ON f.id = fe.finding_id
            WHERE fe.session_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM finding_verdicts v WHERE v.finding_id = f.id)
            GROUP BY fe.finding_id, f.title
         ) t WHERE n = 1 ORDER BY finding_id LIMIT 1`,
      )
    ).rows[0];
    if (!single) throw new Error("no single-session pending finding to use as a scoping oracle");
    const other = await client.query<{ session_id: string }>(
      `SELECT fe.session_id
         FROM finding_evidence fe
        WHERE fe.session_id IS NOT NULL
          AND fe.session_id <> $1
          AND fe.finding_id <> $2
        LIMIT 1`,
      [single.session_id, single.finding_id],
    );
    if (!other.rows[0]) throw new Error("no other session with findings for the negative case");
    return {
      findingId: single.finding_id,
      title: single.title,
      ownerSession: single.session_id,
      otherSession: other.rows[0].session_id,
    };
  });
}

export function registerFixtureHooks() {
  test.beforeAll(async () => {
    await seedCostFallbackFixtures();
    await seedFindingFixtures();
    await seedSubagentFixtures();
  });

  test.afterAll(async () => {
    await cleanupSubagentFixtures();
    await cleanupFindingFixtures();
    await cleanupCostFallbackFixtures();
  });
}

export async function expandAllTurns(page: Page) {
  const expand = page.locator(`[data-testid="turn-filter"] button`, { hasText: "Expand turns" });
  if ((await expand.count()) > 0) await expand.click();
}

export async function seedPrFixture() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM session_commits WHERE session_id IN ($1,$2)", [
      PR_FIXTURE.shaSession,
      PR_FIXTURE.branchSession,
    ]);
    await client.query("DELETE FROM transcript_events WHERE session_id IN ($1,$2)", [
      PR_FIXTURE.shaSession,
      PR_FIXTURE.branchSession,
    ]);
    await client.query("DELETE FROM sessions WHERE id IN ($1,$2)", [
      PR_FIXTURE.shaSession,
      PR_FIXTURE.branchSession,
    ]);
    await client.query("DELETE FROM pr_commits WHERE pr_id = $1", [PR_FIXTURE.prId]);
    await client.query("DELETE FROM pull_requests WHERE id = $1", [PR_FIXTURE.prId]);
    await client.query("DELETE FROM projects WHERE id = $1", [PR_FIXTURE.projectId]);
    await client.query(
      "INSERT INTO projects (id,display_name,git_remote,cwd_hint) VALUES ($1,$2,$3,$4)",
      [
        PR_FIXTURE.projectId,
        "G1 PR Linkage Fixture",
        "https://github.com/lathe-fixture/g1-pr-linkage.git",
        null,
      ]
    );
    await client.query(
      `INSERT INTO pull_requests (
         id,project_id,number,node_id,title,body,state,url,author_login,head_ref_name,head_sha,base_ref_name,
         additions,deletions,changed_files,review_count,reviews,created_at,updated_at,merged_at
       )
       VALUES ($1,$2,1,'fixture-node-1','G1 fixture PR: SHA and branch linkage',
         'Synthetic PR used by Lathe acceptance verification.','open',
         'https://github.com/lathe-fixture/g1-pr-linkage/pull/1','fixture-user',$3,$4,'main',
         12,3,2,1,$5::jsonb,'2026-06-11T00:00:00Z','2026-06-11T00:00:00Z',NULL)`,
      [
        PR_FIXTURE.prId,
        PR_FIXTURE.projectId,
        PR_FIXTURE.branch,
        PR_FIXTURE.sha,
        JSON.stringify([{ state: "APPROVED", author: { login: "reviewer" }, body: "fixture review", submittedAt: "2026-06-11T00:00:00Z" }]),
      ]
    );
    await client.query("INSERT INTO pr_commits (pr_id,sha,committed_at) VALUES ($1,$2,$3)", [
      PR_FIXTURE.prId,
      PR_FIXTURE.sha,
      "2026-06-11T00:00:00Z",
    ]);
    for (const session of [
      { id: PR_FIXTURE.shaSession, title: "Fixture session linked by SHA", branch: "different-branch", commits: 1 },
      { id: PR_FIXTURE.branchSession, title: "Fixture session linked by branch fallback", branch: PR_FIXTURE.branch, commits: 0 },
    ]) {
      await client.query(
        `INSERT INTO sessions (
           id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,
           edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,cost_usd,summary,seq
         )
         VALUES ($1,$2,'G1 PR Linkage Fixture',$3,'codex','<synthetic>','done',
           '2026-06-11 00:00:00','2026-06-11 00:00:00',0,1,0,0,0,0,0,0,0,0,$4,$5,NULL,'fixture',900001)`,
        [session.id, PR_FIXTURE.projectId, session.title, session.branch, session.commits]
      );
      await client.query(
        `INSERT INTO transcript_events (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
         VALUES ($1,$2,1,'00:00:00','user_message','user',$3,$3,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
        [`${session.id}_1`, session.id, session.title]
      );
    }
    await client.query("INSERT INTO session_commits (session_id,sha,event_id,source) VALUES ($1,$2,$3,'fixture')", [
      PR_FIXTURE.shaSession,
      PR_FIXTURE.shaPrefix,
      `${PR_FIXTURE.shaSession}_1`,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
