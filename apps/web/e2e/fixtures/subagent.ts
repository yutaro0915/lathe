// e2e/fixtures/subagent.ts — the sub-agent session-linking fixture: a parent
// session that spawns one linked child session plus one dangling launcher.
// Extracted verbatim from e2e/helpers.ts (file-size gate, I4); helpers.ts
// re-exports these symbols so existing import sites stay unbroken.
import { withDb } from "./db";

export const SUBAGENT_FIXTURE = {
  projectId: "fixture:subagent-session-linking",
  parentId: "fixture-subagent-parent-session",
  childId: "fixture-subagent-child-session",
  missingAgentId: "fixture-subagent-missing-session",
  linkedLauncherId: "fixture-subagent-parent-session-event-2",
  unlinkedLauncherId: "fixture-subagent-parent-session-event-3",
};

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
