// e2e/fixtures/session-class.ts — session_class filter fixture.
//
// One non-development root session with visible errors. It must be hidden by
// default listSessions() consumers and visible only when the UI opts into the
// internal class.
import { withDb } from "./db";

export const SESSION_CLASS_FIXTURE = {
  projectId: "fixture:session-class-filter",
  sessionId: "fixture-session-class-internal",
  title: "E2E internal session class fixture",
  findingTitle: "E2E internal session class failure-loop finding",
} as const;

export async function seedSessionClassFixtures() {
  await cleanupSessionClassFixtures();
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO projects (id,display_name,git_remote,cwd_hint)
       VALUES ($1,'Session Class Filter Fixture',NULL,NULL)
       ON CONFLICT (id) DO UPDATE
          SET display_name = EXCLUDED.display_name,
              updated_at = CURRENT_TIMESTAMP`,
      [SESSION_CLASS_FIXTURE.projectId],
    );
    await client.query(
      `INSERT INTO sessions (
         id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,
         turn_count,tool_count,edit_count,bash_count,subagent_count,error_count,
         token_usage,token_in,token_out,git_branch,commit_count,cost_usd,summary,seq,session_class
       )
       VALUES (
         $1,$2,'Session Class Filter Fixture',$3,'codex','<synthetic>','done',
         '2026-06-13 00:00:00','2026-06-13 00:00:05',5000,
         1,1,0,1,0,7,
         250,150,100,'inner/session-class-filter',0,0.03,'internal fixture',910024,'internal'
       )`,
      [
        SESSION_CLASS_FIXTURE.sessionId,
        SESSION_CLASS_FIXTURE.projectId,
        SESSION_CLASS_FIXTURE.title,
      ],
    );
    const finding = (
      await client.query<{ id: number }>(
        `INSERT INTO findings (analyst,kind,title,body,confidence,project_id)
         VALUES ('rules-v1','failure_loop',$1,'Internal fixture finding for class-scoped Overview trends.',0.74,$2)
         RETURNING id`,
        [SESSION_CLASS_FIXTURE.findingTitle, SESSION_CLASS_FIXTURE.projectId],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO finding_evidence (finding_id,subject_kind,session_id,locator,subject_id,note)
       VALUES ($1,'session',$2,$3::jsonb,$2,'internal class trend evidence')`,
      [
        finding.id,
        SESSION_CLASS_FIXTURE.sessionId,
        JSON.stringify({ session_id: SESSION_CLASS_FIXTURE.sessionId }),
      ],
    );
  });
}

export async function cleanupSessionClassFixtures() {
  await withDb(async (client) => {
    await client.query(
      `DELETE FROM finding_evidence
        USING findings
       WHERE finding_evidence.finding_id = findings.id
         AND findings.project_id = $1`,
      [SESSION_CLASS_FIXTURE.projectId],
    );
    await client.query("DELETE FROM findings WHERE project_id = $1", [SESSION_CLASS_FIXTURE.projectId]);
    await client.query("DELETE FROM sessions WHERE id = $1", [SESSION_CLASS_FIXTURE.sessionId]);
    await client.query("DELETE FROM projects WHERE id = $1", [SESSION_CLASS_FIXTURE.projectId]);
  });
}
