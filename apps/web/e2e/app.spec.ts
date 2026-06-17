import { test, expect, type Page } from "@playwright/test";
import { Client } from "pg";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
  parent_session_id: string | null;
  runner: string;
  cost_usd: number | null;
  cost_anomaly_group_size: number;
  cost_anomaly_group_median_usd: number | null;
  cost_anomaly_threshold_usd: number;
  cost_anomaly: boolean;
};
type FindingOracle = {
  pending_count: number;
  id: number;
  analyst: string;
  kind: string;
  evidence_count: number;
};

const turnCache = new Map<string, Promise<TurnExpectation[]>>();
const COST_FIXTURE_IDS = [
  "e2e-cost-fallback-low",
  "e2e-cost-fallback-high",
  "e2e-cost-fallback-null",
] as const;
const COST_FIXTURE_PROJECT_ID = "fixture:g9-cost-anomaly";

const PR_FIXTURE = {
  projectId: "fixture:g1-pr-linkage",
  prId: "fixture:g1-pr-linkage#1",
  shaSession: "fixture-sha-session",
  branchSession: "fixture-branch-session",
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  shaPrefix: "aaaaaaa",
  branch: "feature/g1-pr-linkage-fixture",
};

const FINDING_FIXTURE = {
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

const SUBAGENT_FIXTURE = {
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
async function firstSessionId(page: Page): Promise<string> {
  await expect(page.locator(".session-list .session-item").first()).toBeVisible();
  const id = await page
    .locator(".session-list .session-item")
    .first()
    .getAttribute("data-session-id");
  if (!id) throw new Error("no session row found on the Sessions surface");
  return id;
}
// Open the workspace on the most-recent session (optionally on a given ?tab=…).
// Use where a test previously did goto("/") and then drove the viewer.
async function gotoViewer(page: Page, query = ""): Promise<string> {
  await page.goto("/");
  const id = await firstSessionId(page);
  const sep = query ? `&${query}` : "";
  await page.goto(`/?session=${encodeURIComponent(id)}${sep}`);
  return id;
}

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

async function cleanupFindingFixtures() {
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

async function cleanupSubagentFixtures() {
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

async function seedSubagentFixtures() {
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

async function seedFindingFixtures() {
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

async function getFindingOracle(title = FINDING_FIXTURE.titles.jump): Promise<FindingOracle> {
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
async function pendingFindingsForSession(sessionId: string): Promise<number> {
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

async function verdictCountForFinding(title: string): Promise<number> {
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

async function seedCostFallbackFixtures() {
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

async function cleanupCostFallbackFixtures() {
  await withDb(async (client) => {
    await client.query("DELETE FROM sessions WHERE id = ANY($1::text[])", [COST_FIXTURE_IDS]);
    await client.query("DELETE FROM projects WHERE id = $1", [COST_FIXTURE_PROJECT_ID]);
  });
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

async function findMultiFileDiffSession(): Promise<string> {
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
  await seedFindingFixtures();
  await seedSubagentFixtures();
});

test.afterAll(async () => {
  await cleanupSubagentFixtures();
  await cleanupFindingFixtures();
  await cleanupCostFallbackFixtures();
});

async function expandAllTurns(page: Page) {
  const expand = page.locator(".turn-filter button", { hasText: "Expand turns" });
  if ((await expand.count()) > 0) await expand.click();
}

async function seedPrFixture() {
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

// Assertions are structural (counts change, classes toggle, URL changes) rather
// than tied to specific seeded titles, so they stay green as the ingested
// transcripts grow.

test.describe("Sessions surface + viewer (/)", () => {
  test("the list surface shows sessions; opening a row reveals the named viewer", async ({ page }) => {
    // bare "/" is the full-width Sessions LIST surface (left = nav only).
    await page.goto("/");
    await expect(page.locator(".session-list .session-item").first()).toBeVisible();
    // opening a row drills into the per-session WORKSPACE: named header + timeline.
    await gotoViewer(page);
    await expect(page.locator(".sessbar .sessbar-title")).toBeVisible();
    await expect(page.locator(".sessbar .sessbar-stats")).toContainText("tokens");
    expect(await page.locator(".event-row").count()).toBeGreaterThan(0);
  });

  test("tabs switch the centre content", async ({ page }) => {
    await gotoViewer(page);
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
    await gotoViewer(page);
    const before = await page.locator(".event-row").count();
    await page.locator(".filters .event-type-badge").first().click();
    await expect
      .poll(async () => page.locator(".event-row").count())
      .toBeLessThan(before);
  });

  test("clicking an event selects it (detail panel)", async ({ page }) => {
    await gotoViewer(page);
    const rows = page.locator(".event-row");
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    await rows.first().click();
    await expect(page.locator(".event-row.selected")).toHaveCount(1);
  });

  test("the surface search filters the list and clears", async ({ page }) => {
    // the search box lives on the list surface itself (no session open yet).
    await page.goto("/");
    await expect(page.locator(".session-list .session-item").first()).toBeVisible();
    const before = await page.locator(".session-item").count();
    expect(before).toBeGreaterThan(0);
    const box = page.getByPlaceholder(/Search sessions/i);
    await box.fill("zzz-no-such-session-zzz");
    // a no-match search collapses the full-width list (there is no session being
    // viewed to force-include on this surface).
    await expect(page.locator(".session-item")).toHaveCount(0);
    await box.fill("");
    await expect(page.locator(".session-item")).toHaveCount(before);
  });

  test("clicking a list row navigates with ?session= into the viewer", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".session-list .session-item").first()).toBeVisible();
    await page.locator(".session-item").first().click();
    await expect(page).toHaveURL(/\?session=/);
    // the viewer keeps its own sidebar list, with the open session marked active.
    await expect(page.locator(".session-item.active")).toHaveCount(1);
  });

  test("Pin persists to localStorage", async ({ page }) => {
    await gotoViewer(page);
    await page.locator(".event-row").nth(0).click();
    await page.locator(".btn", { hasText: /Pin/i }).first().click();
    const pins = await page.evaluate(() => localStorage.getItem("lathe.pins"));
    expect(pins && pins.length).toBeTruthy();
  });

  test("cost is derived from token usage and shown ($)", async ({ page }) => {
    // the list surface shows priceable (Opus) sessions with a real dollar amount.
    await page.goto("/");
    await expect(page.locator(".session-list .session-item").first()).toBeVisible();
    const dollarCosts = page.locator(".session-item .chip.cost", { hasText: "$" });
    expect(await dollarCosts.count()).toBeGreaterThan(0);
    // and the viewer header carries the matching Cost stat.
    await gotoViewer(page);
    await expect(
      page.locator(".sessbar-stats .kstat", { hasText: "cost" })
    ).toBeVisible();
  });
});

test.describe("Cost anomaly detection", () => {
  const CLAUDE_JUMP_SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";

  test("session-list anomaly chips match an independent DB baseline oracle", async ({ page }) => {
    const oracle = await getCostAnomalyExpectations();
    const expected = oracle
      .filter((r) => r.cost_anomaly && !r.parent_session_id)
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
    // the three cost fixtures match the search on the full-width Sessions list
    // surface; assert on the three fixture rows specifically.
    for (const id of COST_FIXTURE_IDS) {
      await expect(page.locator(`.session-item[data-session-id="${id}"]`)).toHaveCount(1);
    }
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

  test("overview surfaces the G9 cost flag in the cost-outliers list", async ({ page }) => {
    await page.goto("/overview");
    await page.locator(".project-picker").selectOption("(no edits)");
    // Overview v2 has no session rail; the anomalous session is a row in the
    // attention panel's cost-alerts column, carrying a ▲ cost flag, and links
    // straight to that session's viewer.
    const row = page.locator(
      `[data-attn-group="cost"] .attn-row[data-session-id="${COST_FIXTURE_IDS[1]}"]`
    );
    await expect(row).toBeVisible();
    // the row shows the session cost and an overrun ratio (cost ÷ baseline). Being
    // in the cost-alerts column already means it is anomalous, so the ▲ flag is
    // redundant here; the ratio badge is the "how bad" signal.
    await expect(row.locator(".attn-ratio")).toBeVisible();
    await expect(row).toContainText("$51.00");
    await expect(row).toHaveAttribute(
      "href",
      `/?session=${encodeURIComponent(COST_FIXTURE_IDS[1])}`
    );
  });

  test("highest-turn jump expands and activates the estimated-cost turn for Claude Code", async ({ page }) => {
    const target = highestCostTurn(await getTurnExpectations(CLAUDE_JUMP_SID));
    expect(target).toBeTruthy();
    await expectTurnJump(page, CLAUDE_JUMP_SID, "COSTLIEST TURN", target, "cost");
  });

  test("highest-turn jump expands and activates the duration fallback turn for Codex", async ({ page }) => {
    const codexSession = await findCompactCodexSession();
    const target = longestWallDurationTurn(await getTurnExpectations(codexSession));
    expect(target).toBeTruthy();
    expect(target.wallDurationMs).toBeGreaterThan(0);
    await expectTurnJump(page, codexSession, "LONGEST TURN", target, "duration");
  });

  test("error-turn jump expands and activates the first failing turn", async ({ page }) => {
    const target = (await getTurnExpectations(CLAUDE_JUMP_SID)).find(
      (t) => t.steps > 0 && t.errors > 0
    );
    expect(target).toBeTruthy();
    await expectTurnJump(page, CLAUDE_JUMP_SID, "FIRST ERROR TURN", target!);
  });
});

test.describe("Diff viewer (/diff)", () => {
  test("loads with changed files and a diff", async ({ page }) => {
    await page.goto("/diff");
    await expect(page.locator(".file-row").first()).toBeVisible();
    expect(await page.locator(".diff-hunk").count()).toBeGreaterThan(0);
  });

  test("selecting a file updates the diff path", async ({ page }) => {
    const sessionId = await findMultiFileDiffSession();
    await page.goto(`/diff?session=${encodeURIComponent(sessionId)}`);
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
    await gotoViewer(page);
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
    await gotoViewer(page);
    await expect(page.locator(".ribbon-track")).toBeVisible();
    expect(await page.locator(".ribbon-seg").count()).toBeGreaterThan(0);
  });

  test("time ribbon zoom widens the track", async ({ page }) => {
    await gotoViewer(page);
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

  test("linked Codex sub-agent shows child session facts and opens the sub-session", async ({
    page,
  }) => {
    await page.goto(`/?session=${SUBAGENT_FIXTURE.parentId}&tab=subagents`);
    const linked = page.locator(".sa-card", { hasText: "Linked fixture subagent task" });
    await expect(linked).toContainText("3 steps");
    await expect(linked).toContainText("2 tools");
    await expect(linked).toContainText(/gpt-5/i);
    await expect(linked).toContainText("$0.13");
    await expect(linked).toContainText("OPEN SUB-SESSION");
    await linked.getByText("OPEN SUB-SESSION").click();
    await expect(page).toHaveURL(new RegExp(`session=${SUBAGENT_FIXTURE.childId}`));
    await expect(page.locator(".sessbar-title")).toHaveText("Fixture linked sub-session");
  });

  test("unlinked Codex sub-agent is explicit about missing internal steps", async ({
    page,
  }) => {
    await page.goto(`/?session=${SUBAGENT_FIXTURE.parentId}&tab=subagents`);
    const unlinked = page.locator(".sa-card", { hasText: "Missing fixture subagent task" });
    await expect(unlinked).toContainText("internal steps not captured");
  });

  test("sub-sessions are hidden from the rail until the toggle is enabled", async ({
    page,
  }) => {
    await page.goto(`/?session=${SUBAGENT_FIXTURE.parentId}`);
    const childItem = page.locator(
      `.session-list [data-session-id="${SUBAGENT_FIXTURE.childId}"]`
    );
    await expect(childItem).toHaveCount(0);
    await page.getByLabel("show sub-sessions").check();
    await expect(childItem).toBeVisible();
    await expect(childItem.locator(".sub-session-badge")).toHaveText("SUB");
  });

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
    await gotoViewer(page);
    const track = page.locator(".ribbon-track");
    await expect(track).toBeVisible();
    const box = await track.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
      await expect(page.locator(".ribbon-read")).toContainText(/\d{2}:\d{2}:\d{2}/);
    }
  });

  test("ribbon: clicking the track selects the step at the cursor", async ({ page }) => {
    await gotoViewer(page);
    const track = page.locator(".ribbon-track");
    const box = await track.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
      await expect(page.locator(".event-row.selected")).toHaveCount(1);
    }
  });

  test("ribbon: zooming in adds more time-axis ticks", async ({ page }) => {
    await gotoViewer(page);
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

test.describe("Findings tab and verdict oracle", () => {
  test("fixture findings are listed and the pending badge matches the DB oracle", async ({
    page,
  }) => {
    const oracle = await getFindingOracle();
    // the tab is session-scoped, so its badge = pending findings ON THIS session
    // (not the project-wide pending total).
    const sessionPending = await pendingFindingsForSession(FINDING_FIXTURE.sessionId);
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);

    const tab = page.locator(".tabs .tab", { hasText: "Findings" });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveClass(/active/);
    await expect(tab.locator(".tab-count")).toHaveText(String(sessionPending));

    const row = page.locator(`.finding-row[data-finding-id="${oracle.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-kind", oracle.kind);
    await expect(row).toHaveAttribute("data-analyst", oracle.analyst);
    await expect(row).toHaveAttribute("data-verdict", "pending");
    await expect(row).toHaveAttribute("data-evidence-count", String(oracle.evidence_count));
    await expect(row).toContainText(FINDING_FIXTURE.titles.jump);

    // master-detail: list rows carry NO accept/reject button — the decision
    // lives in the detail panel only, so it is never made from the list alone.
    await expect(row.locator(".finding-verdict-btn")).toHaveCount(0);
  });

  test("clicking a list row opens its detail panel with verdict controls", async ({
    page,
  }) => {
    const title = FINDING_FIXTURE.titles.verdict;
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);

    const row = page.locator(".finding-row", { hasText: title });
    await row.click();
    await expect(row).toHaveClass(/active/);

    const detail = page.locator(".finding-detail[data-detail-finding-id]");
    await expect(detail).toContainText(title);
    await expect(detail.locator(".finding-verdict-btn.accept")).toBeVisible();
    await expect(detail.locator(".finding-verdict-btn.reject")).toBeVisible();
  });

  test("Accept with a short reason inserts a verdict and Undo removes it", async ({
    page,
  }) => {
    const title = FINDING_FIXTURE.titles.jump;
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);

    await page.locator(".finding-row", { hasText: title }).click();
    const detail = page.locator(".finding-detail[data-detail-finding-id]");
    await detail.locator(".finding-verdict-reason").fill("valid fixture");
    await detail.locator(".finding-verdict-btn.accept").click();

    await expect(page.locator(".finding-verdict-toast.accept")).toContainText("Accepted");
    await expect.poll(async () => verdictCountForFinding(title)).toBe(1);

    await page.locator(".finding-verdict-toast .btn", { hasText: "Undo" }).click();
    await expect.poll(async () => verdictCountForFinding(title)).toBe(0);
    await expect(page.locator(".finding-row", { hasText: title })).toHaveAttribute("data-verdict", "pending");
  });

  test("verdict completion stays within one selecting click plus typing and Enter", async ({
    page,
  }) => {
    const title = FINDING_FIXTURE.titles.verdict;
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);

    // open the detail panel for this finding (the one click the flow needs)…
    await page.locator(".finding-row", { hasText: title }).click();
    const detail = page.locator(".finding-detail[data-detail-finding-id]");
    await expect(detail).toContainText(title);

    // …then count any FURTHER clicks: the verdict itself must complete with no
    // additional button click — just typing a reason and pressing Enter.
    await page.evaluate(() => {
      (window as typeof window & { __findingClicks?: number }).__findingClicks = 0;
      document.addEventListener(
        "click",
        (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest(".findings-tab")) {
            (window as typeof window & { __findingClicks?: number }).__findingClicks =
              ((window as typeof window & { __findingClicks?: number }).__findingClicks ?? 0) + 1;
          }
        },
        { capture: true, once: false }
      );
    });

    const input = detail.locator(".finding-verdict-reason");
    await input.fill("enter accepted");
    await input.press("Enter");

    await expect.poll(async () => verdictCountForFinding(title)).toBe(1);
    const clicks = await page.evaluate(
      () => (window as typeof window & { __findingClicks?: number }).__findingClicks ?? 0
    );
    expect(clicks).toBe(0);
  });

  test("detail evidence excerpt shows the evidence command from the seq", async ({ page }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    // turn-kind evidence with a { seq } locator — the analyst's real contract.
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const detail = page.locator(".finding-detail[data-detail-finding-id]");
    const card = detail.locator('.finding-evidence-card[data-evidence-kind="turn"]');
    await expect(card).toHaveAttribute("data-resolved", "true");
    // the seq-2 fixture event is `pnpm test` exiting 1 — its command must render.
    await expect(card.locator(".finding-excerpt")).toContainText("pnpm test");
    // the step number now rides the step row header (session-wide step index).
    await expect(card.locator(".finding-evidence-stepno")).toContainText("STEP 2");
    await expect(card.locator(".finding-evidence-exit")).toContainText("exit 1");
  });

  test("seq-locator turn evidence jumps to and flashes the transcript step", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const detail = page.locator(".finding-detail[data-detail-finding-id]");
    await detail.locator('.finding-evidence-card[data-evidence-kind="turn"] .finding-evidence-jump').click();

    await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
    const target = page.locator(`.event-row[data-eid="${FINDING_FIXTURE.eventId}"]`);
    await expect(target).toHaveClass(/selected/);
    await expect(target).toHaveAttribute("data-flash", "true");
  });

  test("evidence clicks activate the transcript step and the diff hunk", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.jump }).click();
    const detail = page.locator(".finding-detail[data-detail-finding-id]");

    await detail.locator('.finding-evidence-card[data-evidence-kind="event"] .finding-evidence-jump').click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
    await expect(page.locator(`.event-row.selected[data-eid="${FINDING_FIXTURE.eventId}"]`)).toBeVisible();

    await page.locator(".tabs .tab", { hasText: "Findings" }).click();
    // the detail panel keeps the same finding selected, so the hunk evidence
    // card is still present — its jump opens the Git tab on that hunk.
    await detail.locator('.finding-evidence-card[data-evidence-kind="hunk"] .finding-evidence-jump').click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Git/);
    await expect(page.locator(`.file-row.active[data-file-id="${FINDING_FIXTURE.fileId}"]`)).toBeVisible();
    await expect(page.locator(`.diff-hunk.active[data-hunk-id="${FINDING_FIXTURE.hunkId}"]`)).toBeVisible();
  });

  test("the Findings tab drops the right event inspector and uses a 2-col layout", async ({
    page,
  }) => {
    // On Transcript the right inspector (RUN JSON / LINKED FILES) is present…
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=transcript`);
    await expect(page.locator(".layout3 > aside.aside")).toBeVisible();

    // …on Findings it is removed entirely and the grid is 2-column, so the whole
    // width goes to the findings master-detail (the inspector informs no verdict).
    await page.locator(".tabs .tab", { hasText: "Findings" }).click();
    await expect(page.locator(".layout3")).toHaveAttribute("data-tab", "findings");
    await expect(page.locator(".layout3 > aside.aside")).toHaveCount(0);
    const cols = await page
      .locator(".layout3")
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
    expect(cols).toBe(2);
  });

  test("session tab evidence: NO SESSION header, but turn position + USER ASKED + AFTERWARD", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    // the turn-seq finding points at the seq-2 failing command — a deterministic
    // anchor for the surrounding story in the fixture.
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const card = page
      .locator(".finding-detail[data-detail-finding-id]")
      .locator('.finding-evidence-card[data-evidence-kind="turn"]');
    await expect(card).toHaveAttribute("data-resolved", "true");

    // requirement A: inside the session viewer every finding already belongs to
    // this session, so the SESSION header (title / runner / start time) is noise
    // and is suppressed.
    await expect(card.locator(".finding-evidence-session")).toHaveCount(0);

    // …but the turn POSITION that used to ride on the session meta line moves to
    // the group header, so "where in the run" is still legible.
    await expect(card.locator(".finding-evidence-grouphead .finding-evidence-position")).toContainText(
      "turn 1/1"
    );

    // USER ASKED — the nearest preceding user prompt (seq 1 in the fixture).
    const trigger = card.locator(".finding-evidence-trigger");
    await expect(trigger).toContainText("Please inspect the fixture.");
    await expect(trigger.locator(".finding-evidence-trigger-seq")).toContainText("step 1");

    // evidence — the step's excerpt still renders the failing command.
    await expect(card.locator(".finding-excerpt")).toContainText("pnpm test");

    // AFTERWARD — failure_loop escapes to the next non-failure event (the seq-3
    // assistant message in the fixture).
    const after = card.locator(".finding-evidence-after");
    await expect(after).toHaveAttribute("data-after-seq", "3");
    await expect(after).toContainText("The fixture command failed once.");
  });

  test("the cross-session axis DOES show the SESSION header (it spans many runs)", async ({
    page,
  }) => {
    await page.goto("/findings");
    await page.locator(".findings-filter button", { hasText: "All" }).click();
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const card = page
      .locator(".finding-detail[data-detail-finding-id]")
      .locator('.finding-evidence-card[data-evidence-kind="turn"]');
    const session = card.locator(".finding-evidence-session");
    await expect(session).toHaveAttribute("data-session-id", FINDING_FIXTURE.sessionId);
    await expect(session.locator(".finding-evidence-session-title")).toContainText(
      "Fixture findings session"
    );
    await expect(session.locator(".finding-evidence-session-meta")).toContainText("Codex");
  });

  test("evidence in the same (session, turn) collapses into ONE group with one row per step", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.grouped }).click();
    const detail = page.locator(".finding-detail[data-detail-finding-id]");

    // two same-turn evidence rows (seqs 2 and 3) → exactly ONE group card…
    const cards = detail.locator(".finding-evidence-card");
    await expect(cards).toHaveCount(1);
    const card = cards.first();
    await expect(card).toHaveAttribute("data-group-size", "2");

    // …carrying a mono repeat count…
    await expect(card.locator(".finding-evidence-repeats")).toContainText("×2 repeats");

    // …USER ASKED shown once for the whole group…
    await expect(card.locator(".finding-evidence-trigger")).toHaveCount(1);

    // …and one STEP row per seq, in time order (236-style session-wide step no.).
    const steps = card.locator(".finding-evidence-step");
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0).locator(".finding-evidence-stepno")).toContainText("STEP 2");
    await expect(steps.nth(1).locator(".finding-evidence-stepno")).toContainText("STEP 3");
    // the step number is annotated with what "step" means (session-wide index).
    await expect(steps.nth(0).locator(".finding-evidence-stepno")).toHaveAttribute(
      "title",
      /Session-wide step number/
    );

    // AFTERWARD appears once, at the end of the group (not per step).
    await expect(card.locator(".finding-evidence-after")).toHaveCount(1);
  });
});

// ---- triage: jump actions + embedded transcript + sticky verdict + layout ---
// The Findings detail becomes a triage surface: jump to the session / turn,
// read the surrounding transcript inline, decide without scrolling past it, and
// never have the layout shift under selection (design/ui-design-language.md).
test.describe("Findings triage (jumps, embedded transcript, sticky verdict, layout)", () => {
  // ① the SESSION header (axis) jumps to that session's transcript
  test("clicking the SESSION header opens the session viewer transcript", async ({ page }) => {
    await page.goto("/findings");
    await page.locator(".findings-filter button", { hasText: "All" }).click();
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const card = page
      .locator(".finding-detail[data-detail-finding-id]")
      .locator('.finding-evidence-card[data-evidence-kind="turn"]');
    const sessionJump = card.locator("button.finding-evidence-session-jump");
    await expect(sessionJump).toHaveAttribute("data-session-id", FINDING_FIXTURE.sessionId);
    await sessionJump.click();
    // lands on the owning session's viewer, on the Transcript tab
    await expect(page).toHaveURL(new RegExp(`session=${FINDING_FIXTURE.sessionId}`));
    await expect(page).toHaveURL(/tab=transcript/);
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
  });

  // ② the TURN header row jumps to the transcript positioned at that turn
  test("clicking the TURN position jumps to that turn's step in the transcript", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const card = page
      .locator(".finding-detail[data-detail-finding-id]")
      .locator('.finding-evidence-card[data-evidence-kind="turn"]');
    const turnJump = card.locator("button.finding-evidence-action-turn");
    await expect(turnJump).toHaveAttribute("data-turn", "1");
    await expect(turnJump).toHaveText(/VIEW TURN/);
    await turnJump.click();
    // same session → in-page: transcript tab active and the turn-head step (seq 1,
    // the USER ASKED prompt) is selected + flashed.
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
    const head = page.locator(`.event-row[data-eid="${FINDING_FIXTURE.sessionId}-event-1"]`);
    await expect(head).toHaveClass(/selected/);
  });

  // ⑤ expanding an evidence group reveals the inline turn transcript rows
  test("expanding the inline transcript shows the turn's event rows inline", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    // the grouped finding folds two same-turn steps into one card; the fixture
    // session's turn 1 has 4 top-level events (seqs 1/2/3/4).
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.grouped }).click();
    const card = page.locator(".finding-detail[data-detail-finding-id] .finding-evidence-card").first();

    const toggle = card.locator(".finding-evidence-turn-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    const transcript = card.locator(".finding-turn-transcript");
    await expect(transcript).toBeVisible();
    // the four turn-1 events render as compact rows…
    const rows = transcript.locator(".finding-turn-event");
    await expect(rows).toHaveCount(4);
    // …the failing bash step (seq 2) shows its command + non-zero exit and is
    // flagged as this finding's own evidence.
    const evRow = transcript.locator('.finding-turn-event[data-seq="2"]');
    await expect(evRow).toHaveAttribute("data-evidence", "true");
    await expect(evRow.locator(".finding-turn-event-cmd")).toContainText("pnpm test");
    await expect(evRow.locator(".finding-turn-event-exit")).toContainText("exit 1");
    // the duplicate "open in session" link inside the embed is gone (requirement
    // C): VIEW TURN / VIEW SESSION in the group header are the single way out.
    await expect(transcript.locator(".finding-turn-open")).toHaveCount(0);
    await expect(card.locator(".finding-evidence-action-session")).toBeVisible();

    // clicking an inline row deep-links to that exact step in the transcript
    await evRow.click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
    await expect(page.locator(`.event-row.selected[data-eid="${FINDING_FIXTURE.eventId}"]`)).toBeVisible();
  });

  // ③ the verdict bar is visible without scrolling even with long evidence
  test("the verdict bar stays pinned to the panel bottom (sticky) over long evidence", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    // pick a PENDING finding so the Accept/Reject controls render…
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.grouped }).click();
    const detail = page.locator(".finding-detail[data-detail-finding-id]");
    const accept = detail.locator(".finding-verdict-btn.accept");
    await expect(accept).toBeVisible();

    // …expand the inline transcript to grow the evidence well past one screen,
    // then scroll the detail panel to the TOP. The verdict bar must remain within
    // the panel's viewport (sticky), not pushed below the fold.
    await detail.locator(".finding-evidence-turn-toggle").click();
    await detail.evaluate((el) => el.scrollTo(0, 0));

    const acceptBox = await accept.boundingBox();
    const detailBox = await detail.boundingBox();
    expect(acceptBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    // the button's bottom edge sits within the detail panel's box (i.e. visible
    // without scrolling the panel) — the definition of a working sticky bar.
    expect(acceptBox!.y + acceptBox!.height).toBeLessThanOrEqual(
      detailBox!.y + detailBox!.height + 1,
    );
    expect(acceptBox!.y).toBeGreaterThanOrEqual(detailBox!.y - 1);
  });

  // ④ regression for bug D: selecting a 2nd finding must NOT change the layout
  test("selecting the 2nd finding does not shift the list-rail width (bug D)", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    const rows = page.locator(".finding-row");
    await expect(rows.nth(1)).toBeVisible();

    const railWidth = () =>
      page.locator(".findings-list").evaluate((el) => el.getBoundingClientRect().width);

    await rows.nth(0).click();
    const before = await railWidth();
    await rows.nth(1).click();
    const after = await railWidth();
    // the list rail is a fixed track — its width is identical regardless of which
    // finding (and however tall its detail) is selected.
    expect(Math.abs(after - before)).toBeLessThanOrEqual(0.5);

    // and selection is client-side: the URL gains ?finding=<id> via replaceState
    // (no full navigation), so the detail swaps instantly.
    await expect(page).toHaveURL(/finding=/);
  });

  // ④b regression for the Findings left-blank / horizontal-shift bug: on the
  // cross-session AXIS, selecting EACH finding in turn must keep the master-detail
  // grid pinned to the same left edge AND must never make the page scroll
  // horizontally — including the finding whose evidence is a long no-wrap command.
  // A long one-liner is absorbed by per-pane horizontal scroll (design rule: 無言
  // の切り捨て禁止 / ページ幅オーバーフロー構造防止), not by widening the grid.
  test("selecting any finding keeps the grid left edge fixed and never scrolls the page (left-blank bug)", async ({
    page,
  }) => {
    await page.goto("/findings");
    await page.locator(".findings-filter button", { hasText: "All" }).click();
    const rows = page.locator(".finding-row");
    const count = await rows.count();
    expect(count).toBeGreaterThan(1);

    const gridLeft = () =>
      page.locator(".findings-md-grid").evaluate((el) => el.getBoundingClientRect().left);
    const pageOverflow = () =>
      page.evaluate(() => {
        const se = document.scrollingElement!;
        return se.scrollWidth - se.clientWidth;
      });

    let firstLeft: number | null = null;
    for (let i = 0; i < count; i++) {
      await rows.nth(i).click();
      await expect(page.locator(".finding-detail[data-detail-finding-id]")).toBeVisible();
      const left = await gridLeft();
      if (firstLeft === null) firstLeft = left;
      // the grid's left edge is identical for every selection (no rightward shift,
      // no left blank gap opening up).
      expect(Math.abs(left - firstLeft)).toBeLessThanOrEqual(1);
      // and the page itself never gains a horizontal scrollbar.
      expect(await pageOverflow()).toBeLessThanOrEqual(1);
    }
  });

  // ④c the long no-wrap command is absorbed by per-pane horizontal scroll: the
  // excerpt pane scrolls (scrollWidth > clientWidth) but the page does not, and
  // the line is NOT wrapped (white-space:pre) — visible, not silently truncated.
  test("a long no-wrap command scrolls inside its excerpt pane, not the page", async ({
    page,
  }) => {
    await page.goto("/findings");
    await page.locator(".findings-filter button", { hasText: "All" }).click();
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.longLine }).click();
    const detail = page.locator(".finding-detail[data-detail-finding-id]");
    await expect(detail).toBeVisible();
    const pre = detail.locator(".finding-excerpt-pre").first();
    await expect(pre).toBeVisible();

    const m = await pre.evaluate((el) => {
      const se = document.scrollingElement!;
      const cs = getComputedStyle(el);
      return {
        whiteSpace: cs.whiteSpace,
        overflowX: cs.overflowX,
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
        pageScrollW: se.scrollWidth,
        pageClientW: se.clientWidth,
      };
    });
    // the one-liner is NOT wrapped…
    expect(m.whiteSpace).toBe("pre");
    // …it scrolls horizontally inside its own pane…
    expect(m.overflowX).toBe("auto");
    expect(m.scrollW).toBeGreaterThan(m.clientW);
    // …and that scroll never escapes to widen the page.
    expect(m.pageScrollW).toBeLessThanOrEqual(m.pageClientW + 1);
  });

  // ⑥ evidence group header carries BOTH always-visible actions (requirement C):
  // VIEW TURN and VIEW SESSION, each with a destination-describing title — no
  // need to expand the inline transcript to find a way into the session.
  test("evidence group header always shows VIEW TURN and VIEW SESSION actions", async ({
    page,
  }) => {
    await page.goto("/findings");
    await page.locator(".findings-filter button", { hasText: "All" }).click();
    await page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const card = page
      .locator(".finding-detail[data-detail-finding-id]")
      .locator('.finding-evidence-card[data-evidence-kind="turn"]');
    const viewTurn = card.locator(".finding-evidence-action-turn");
    const viewSession = card.locator(".finding-evidence-action-session");
    // both are visible WITHOUT expanding the inline transcript.
    await expect(viewTurn).toBeVisible();
    await expect(viewTurn).toHaveText(/VIEW TURN/);
    await expect(viewTurn).toHaveAttribute("title", /Open the transcript at this turn/);
    await expect(viewSession).toBeVisible();
    await expect(viewSession).toHaveText(/VIEW SESSION/);
    await expect(viewSession).toHaveAttribute("title", /Open the full session transcript/);
  });

  // ⑦ deep-link landing (requirement D): clicking VIEW TURN from the cross-session
  // axis deep-links into the owning session, where a dismissible banner names the
  // step and the originating finding, and the landed step is flashed.
  test("VIEW TURN deep-links into the session with a dismissible landing banner", async ({
    page,
  }) => {
    await page.goto("/findings");
    await page.locator(".findings-filter button", { hasText: "All" }).click();
    const findingRow = page.locator(".finding-row", { hasText: FINDING_FIXTURE.titles.turnSeq });
    await findingRow.click();
    const findingId = await findingRow.getAttribute("data-finding-id");
    expect(findingId).toBeTruthy();

    const card = page
      .locator(".finding-detail[data-detail-finding-id]")
      .locator('.finding-evidence-card[data-evidence-kind="turn"]');
    await card.locator(".finding-evidence-action-turn").click();

    // landed on the owning session's transcript, carrying the originating finding.
    await expect(page).toHaveURL(new RegExp(`session=${FINDING_FIXTURE.sessionId}`));
    await expect(page).toHaveURL(new RegExp(`fromFinding=${findingId}`));

    // the landing banner names the finding and is dismissible…
    const banner = page.locator(".jump-landing-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(`from finding #${findingId}`);

    // …and the landed step is flashed/selected (highlight, requirement D).
    const head = page.locator(`.event-row[data-eid="${FINDING_FIXTURE.sessionId}-event-1"]`);
    await expect(head).toHaveClass(/selected/);

    await banner.locator(".jump-landing-dismiss").click();
    await expect(banner).toHaveCount(0);
  });
});

// ---- IA: one persistent global bar + Findings as a cross-session axis -------
// (design/ui-design-language.md, IA principle 2026-06-12). Three guarantees:
//   1. every route shows the SAME global bar with the current axis highlighted
//   2. the Findings AXIS (/findings) drives the cross-session master-detail
//   3. the session viewer's Findings TAB shows ONLY findings attached to that
//      one session (cross-session is the axis's job)

// Find a finding whose evidence touches exactly one session, plus another
// session that the SAME finding does NOT touch — the scoping oracle. Works on
// fixture and real data alike (no hard-coded session ids).
async function findScopingOracle(): Promise<{
  findingId: number;
  title: string;
  ownerSession: string;
  otherSession: string;
}> {
  return withDb(async (client) => {
    // a PENDING finding whose evidence is tied to exactly one session — pending
    // so it is visible under the tab's default "Pending" filter.
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

test.describe("Global nav & IA axes", () => {
  for (const route of ["/", "/findings", "/pr", "/overview"]) {
    test(`the persistent global bar is present on ${route}`, async ({ page }) => {
      await page.goto(route);
      const nav = page.locator(".globalnav");
      await expect(nav).toBeVisible();
      // the four axes are always there; chat is never a bar item.
      await expect(nav.locator('.globalnav-tab[data-nav="sessions"]')).toBeVisible();
      await expect(nav.locator('.globalnav-tab[data-nav="findings"]')).toBeVisible();
      await expect(nav.locator('.globalnav-tab[data-nav="pr"]')).toBeVisible();
      await expect(nav.locator('.globalnav-tab[data-nav="overview"]')).toBeVisible();
      await expect(nav.locator('.globalnav-tab', { hasText: "Chat" })).toHaveCount(0);
    });
  }

  test("the current axis is highlighted on each route", async ({ page }) => {
    const cases: [string, string][] = [
      ["/", "sessions"],
      ["/findings", "findings"],
      ["/pr", "pr"],
      ["/overview", "overview"],
    ];
    for (const [route, nav] of cases) {
      await page.goto(route);
      const active = page.locator(".globalnav-tab.active");
      await expect(active).toHaveCount(1);
      await expect(active).toHaveAttribute("data-nav", nav);
    }
  });

  test("no Chat entry point survives in the session viewer (chat removed)", async ({ page }) => {
    await gotoViewer(page);
    // neither the old tab nor the sessbar Discuss chip exist anymore.
    await expect(page.locator(".tabs .tab", { hasText: "Chat" })).toHaveCount(0);
    await expect(page.locator(".chat-session-chip")).toHaveCount(0);
  });

  test("the Findings axis renders the cross-session master-detail and decides a verdict", async ({
    page,
  }) => {
    const oracle = await getFindingOracle();
    await page.goto("/findings");
    await expect(page.locator(".globalnav-tab.active")).toHaveAttribute("data-nav", "findings");

    // the same master-detail component as the tab, in axis mode
    await expect(page.locator('.findings-tab[data-findings-mode="axis"]')).toBeVisible();
    const row = page.locator(`.finding-row[data-finding-id="${oracle.id}"]`);
    await expect(row).toBeVisible();
    await row.click();
    const detail = page.locator(".finding-detail[data-detail-finding-id]");
    await expect(detail).toBeVisible();
    await detail.locator(".finding-verdict-reason").fill("axis verified");
    await detail.locator(".finding-verdict-btn.accept").click();
    await expect(page.locator(".finding-verdict-toast.accept")).toContainText("Accepted");
    await expect.poll(async () => verdictCountForFinding(FINDING_FIXTURE.titles.jump)).toBe(1);

    // restore the fixture to pending so the shared seed is not contaminated for
    // later tests (findings are seeded once in beforeAll).
    await page.locator(".finding-verdict-toast .btn", { hasText: "Undo" }).click();
    await expect.poll(async () => verdictCountForFinding(FINDING_FIXTURE.titles.jump)).toBe(0);
  });

  test("the session Findings tab shows only findings attached to THIS session", async ({
    page,
  }) => {
    const oracle = await findScopingOracle();

    // owner session: the finding IS attached → its row is present
    await page.goto(`/?session=${encodeURIComponent(oracle.ownerSession)}&tab=findings`);
    await expect(page.locator('.findings-tab[data-findings-mode="session"]')).toBeVisible();
    await expect(
      page.locator(`.finding-row[data-finding-id="${oracle.findingId}"]`),
    ).toBeVisible();
    // the session tab no longer carries the All/This cross-session toggle
    await expect(page.locator(".findings-tab", { hasText: "All sessions" })).toHaveCount(0);
    // the in-tab "all findings" link is removed (requirement F) — the
    // cross-session axis is reached from the global bar, not from this tab.
    await expect(page.locator(".findings-axis-link")).toHaveCount(0);

    // other session: the SAME finding is NOT attached → its row is absent
    await page.goto(`/?session=${encodeURIComponent(oracle.otherSession)}&tab=findings`);
    await expect(page.locator('.findings-tab[data-findings-mode="session"]')).toBeVisible();
    await expect(
      page.locator(`.finding-row[data-finding-id="${oracle.findingId}"]`),
    ).toHaveCount(0);
    // …but on the axis it is reachable regardless of which session you came from
    await page.goto("/findings");
    await page.locator('.findings-filter button', { hasText: "All" }).click();
    await expect(page.locator(`.finding-row[data-finding-id="${oracle.findingId}"]`)).toBeVisible();
  });

  test("the left Sessions rail stays in sync with the session being viewed", async ({
    page,
  }) => {
    const oracle = await findScopingOracle();

    // deep-link straight into one session (as the Findings axis jump does). The
    // rail's active item must be THIS session — selected and present in the list.
    await page.goto(`/?session=${encodeURIComponent(oracle.ownerSession)}&tab=transcript`);
    const railActive = page.locator(".session-list .session-item.active");
    await expect(railActive).toHaveCount(1);
    await expect(railActive).toHaveAttribute("data-session-id", oracle.ownerSession);
    await expect(railActive).toBeVisible();

    // switching to another session moves the active marker with it — the rail
    // never shows a stale or empty selection.
    await page.goto(`/?session=${encodeURIComponent(oracle.otherSession)}&tab=transcript`);
    const railActive2 = page.locator(".session-list .session-item.active");
    await expect(railActive2).toHaveCount(1);
    await expect(railActive2).toHaveAttribute("data-session-id", oracle.otherSession);
    await expect(railActive2).toBeVisible();
  });

  test("a current session hidden by a rail filter is force-included so it stays identifiable", async ({
    page,
  }) => {
    const oracle = await findScopingOracle();
    await page.goto(`/?session=${encodeURIComponent(oracle.ownerSession)}&tab=transcript`);

    // type a search that cannot match the current session's title, so the filter
    // would normally drop it from the list.
    await page.getByPlaceholder(/Search sessions/i).fill("zzz-no-such-session-title-zzz");

    // the current session is still present AND marked active (requirement C):
    // "which one am I viewing" must never be lost to a filter.
    const railActive = page.locator(".session-list .session-item.active");
    await expect(railActive).toHaveCount(1);
    await expect(railActive).toHaveAttribute("data-session-id", oracle.ownerSession);
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

  test("Overview v2 has NO session rail (it is a full-width canvas, not a 2nd Sessions list)", async ({
    page,
  }) => {
    await page.goto("/overview");
    // the old rail (sidebar + "Sessions in scope" session-list + back-link) is gone.
    await expect(page.locator(".overview-page .sidebar")).toHaveCount(0);
    await expect(page.locator(".overview-page .session-list")).toHaveCount(0);
    await expect(page.locator(".overview-back")).toHaveCount(0);
    // it IS the full-width analysis canvas with the attention panel.
    await expect(page.locator(".overview-canvas")).toBeVisible();
    await expect(page.locator('[data-panel="attention"]')).toBeVisible();
  });

  test("the attention panel is shown and a row click navigates to the session viewer", async ({
    page,
  }) => {
    await page.goto("/overview");
    await page.locator(".project-picker").selectOption("(no edits)");
    // the cost-alert fixture row is a link straight to that session's viewer.
    const row = page.locator(
      `[data-attn-group="cost"] .attn-row[data-session-id="${COST_FIXTURE_IDS[1]}"]`
    );
    await expect(row).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(
      new RegExp(`\\?session=${COST_FIXTURE_IDS[1]}`)
    );
    // the global bar now reads "Sessions" (axis moved via a real link, back works).
    await expect(page.locator(".globalnav-tab.active")).toHaveAttribute("data-nav", "sessions");
  });

  test("biggest-sessions rows carry a status chip set and link to the session viewer", async ({
    page,
  }) => {
    await page.goto("/overview");
    const biggest = page.locator(".chart-card", { hasText: "Biggest sessions by cost" });
    await expect(biggest).toBeVisible();
    const firstRow = biggest.locator(".big-row").first();
    await expect(firstRow).toBeVisible();
    // the row is a link (href into the session viewer) and reserves a status slot.
    await expect(firstRow).toHaveAttribute("href", /\?session=/);
    await expect(firstRow.locator(".big-status")).toHaveCount(1);
    // at least one biggest row in the corpus carries an err / pending / cost flag.
    await expect(biggest.locator(".big-status .badge").first()).toBeVisible();
  });

  test("a model row drills into the Sessions axis filtered to that model", async ({
    page,
  }) => {
    await page.goto("/overview");
    const modelChart = page.locator(".chart-card", { hasText: "Cost by model" });
    // pick a real (linkable) model row and read the model it deep-links to.
    const modelRow = modelChart.locator(".hbar-link").first();
    await expect(modelRow).toBeVisible();
    const model = await modelRow.getAttribute("data-model");
    expect(model).toBeTruthy();
    await modelRow.click();
    await expect(page).toHaveURL(/[?&]model=/);
    // landed on the Sessions axis with the MODEL filter applied (the Model
    // <select> is the one whose options include "All models").
    await expect(page.locator(".globalnav-tab.active")).toHaveAttribute("data-nav", "sessions");
    const modelSelect = page
      .locator(".filter-row select")
      .filter({ has: page.locator('option[value="all"]', { hasText: "All models" }) });
    await expect(modelSelect).toHaveValue(model!);
  });

  test("a cost-over-time bar drills into the Sessions axis scoped to that period", async ({
    page,
  }) => {
    await page.goto("/overview");
    const bar = page.locator(".time-bar-link").first();
    await expect(bar).toBeVisible();
    const from = await bar.getAttribute("data-from");
    const to = await bar.getAttribute("data-to");
    expect(from).toBeTruthy();
    await bar.click();
    await expect(page).toHaveURL(new RegExp(`from=${from}`));
    await expect(page.locator(".globalnav-tab.active")).toHaveAttribute("data-nav", "sessions");
    // the active period shows as a clearable banner in the session-list sidebar.
    const banner = page.locator(".date-range-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-from", from!);
    await expect(banner).toHaveAttribute("data-to", to!);
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

test.describe("PR linkage", () => {
  test("PR list opens linked sessions, and session view shows the PR chip", async ({ page }) => {
    await seedPrFixture();
    await page.goto(`/pr?pr=${encodeURIComponent(PR_FIXTURE.prId)}`);

    await expect(page.locator(".pr-list-item.active")).toContainText("G1 fixture PR");
    await expect(page.locator(".pr-hero")).toContainText("#1");
    await expect(page.locator(".linked-session", { hasText: "Fixture session linked by SHA" })).toBeVisible();
    await expect(page.locator(".linked-session", { hasText: "Fixture session linked by branch fallback" })).toBeVisible();

    await page.locator(".linked-session", { hasText: "Fixture session linked by SHA" }).click();
    await expect(page).toHaveURL(new RegExp(`session=${PR_FIXTURE.shaSession}`));
    await expect(page.locator(".sessbar-title")).toContainText("Fixture session linked by SHA");
    await expect(page.locator(".sessbar .pr-chip", { hasText: "#1 open" })).toBeVisible();
  });
});

// ---- copy hygiene (design/ui-design-language.md, copy principles 2026-06-12) -
// Product copy is neutral English micro-labels: no Japanese, no Japanese/English
// mixed strings, no editorial phrasing. This is a STATIC source check — it walks
// the UI source under components/ and app/ and asserts no CJK code points appear.
// Out of scope (not UI copy, never matched by this check): e2e fixtures/specs,
// lib/, and any DB-derived dynamic strings (those live in the database, not in
// source). Comments are normalized too, so the check is "no CJK anywhere in the
// UI source tree" — the strongest form of the grep gate.
test.describe("copy hygiene (no Japanese in UI source)", () => {
  const CJK = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;
  const UI_DIRS = ["components", "app"] as const;
  // apps/web root, resolved from this spec's directory (apps/web/e2e).
  const WEB_ROOT = resolve(__dirname, "..");

  function collectSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...collectSources(full));
      } else if (/\.(tsx?|css)$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  for (const sub of UI_DIRS) {
    test(`apps/web/${sub} contains no Japanese characters`, () => {
      const offenders: string[] = [];
      for (const file of collectSources(join(WEB_ROOT, sub))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (CJK.test(line)) {
            offenders.push(`${file.replace(WEB_ROOT + "/", "")}:${i + 1}: ${line.trim()}`);
          }
        });
      }
      expect(offenders, `Japanese found in apps/web/${sub}:\n${offenders.join("\n")}`).toEqual([]);
    });
  }
});
