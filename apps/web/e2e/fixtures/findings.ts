// e2e/fixtures/findings.ts — the S2 finding-UI fixture: a synthetic project with
// findings/evidence/verdicts plus its oracle queries. Extracted verbatim from
// e2e/helpers.ts (file-size gate, I4). Behaviour is byte-identical; helpers.ts
// re-exports every symbol so existing `import … from "./helpers"` sites keep working.
import { withDb } from "./db";

export type FindingOracle = {
  pending_count: number;
  id: number;
  analyst: string;
  kind: string;
  evidence_count: number;
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
  analysis: {
    full: {
      impact: "Fixture impact: repeated failure wastes review time.",
      agent_intent: "Fixture intent: inspect the failing command evidence.",
      cause_hypothesis: "Fixture cause: command retry happened without changing strategy.",
    },
    partial: {
      impact: "Fixture impact: token spend crossed the review line.",
      agent_intent: "Fixture intent: estimate the cost risk before accepting.",
    },
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
          `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id,analysis)
           VALUES ('rules-v1','failure_loop',$1,'Repeated failing command in a single turn.',0.92,$2,$3,$4::jsonb)
           RETURNING id`,
          [
            FINDING_FIXTURE.titles.jump,
            FINDING_FIXTURE.harnessId,
            FINDING_FIXTURE.projectId,
            JSON.stringify(FINDING_FIXTURE.analysis.full),
          ]
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
          `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id,analysis)
           VALUES ('llm-v1','excess_cost',$1,'Token cost crossed the review threshold.',0.81,$2,$3,$4::jsonb)
           RETURNING id`,
          [
            FINDING_FIXTURE.titles.verdict,
            FINDING_FIXTURE.harnessId,
            FINDING_FIXTURE.projectId,
            JSON.stringify(FINDING_FIXTURE.analysis.partial),
          ]
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
          `INSERT INTO findings (analyst,kind,title,body,confidence,harness_version_id,project_id,analysis,backlog_status,backlog_actor)
           VALUES ('hybrid-v1','risky_action',$1,'Fixture decided finding.',0.44,$2,$3,$4::jsonb,'open','user')
           RETURNING id`,
          [
            FINDING_FIXTURE.titles.decided,
            FINDING_FIXTURE.harnessId,
            FINDING_FIXTURE.projectId,
            JSON.stringify(FINDING_FIXTURE.analysis.full),
          ]
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

export async function backlogStatusForFinding(title: string): Promise<string | null> {
  return withDb(async (client) => {
    const row = (
      await client.query<{ backlog_status: string | null }>(
        `SELECT backlog_status
           FROM findings
          WHERE title = $1`,
        [title]
      )
    ).rows[0];
    if (!row) throw new Error(`finding backlog missing for ${title}`);
    return row.backlog_status;
  });
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
