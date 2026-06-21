// e2e/fixtures/pr.ts — the G1 PR-linkage fixture: a synthetic PR plus two
// sessions, one linked by SHA and one by branch fallback. Extracted verbatim from
// e2e/helpers.ts (file-size gate, I4); helpers.ts re-exports these symbols so
// existing import sites stay unbroken.
import { Client, DATABASE_URL, withDb } from "./db";

export const PR_FIXTURE = {
  projectId: "fixture:g1-pr-linkage",
  prId: "fixture:g1-pr-linkage#1",
  shaSession: "fixture-sha-session",
  branchSession: "fixture-branch-session",
  sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  shaPrefix: "aaaaaaa",
  branch: "feature/g1-pr-linkage-fixture",
};

// Tear down the PR fixture rows (the same delete order seedPrFixture runs before
// it inserts). seedPrFixture is self-cleaning, so historically no caller needed
// this; the layout-integrity gate seeds the PR fixture in beforeAll and must
// leave the scratch DB as it found it, so it calls this in afterAll.
export async function cleanupPrFixture() {
  await withDb(async (client) => {
    await client.query("BEGIN");
    try {
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
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
