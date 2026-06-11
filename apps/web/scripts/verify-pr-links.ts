import { Pool } from 'pg';
import { getDatabaseUrl } from '../lib/postgres';

const PROJECT_ID = 'fixture:g1-pr-linkage';
const PR_ID = `${PROJECT_ID}#1`;
const SHA_SESSION = 'fixture-sha-session';
const BRANCH_SESSION = 'fixture-branch-session';
const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BRANCH = 'feature/g1-pr-linkage-fixture';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: getDatabaseUrl() });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM session_commits WHERE session_id IN ($1,$2)', [SHA_SESSION, BRANCH_SESSION]);
    await client.query('DELETE FROM transcript_events WHERE session_id IN ($1,$2)', [SHA_SESSION, BRANCH_SESSION]);
    await client.query('DELETE FROM sessions WHERE id IN ($1,$2)', [SHA_SESSION, BRANCH_SESSION]);
    await client.query('DELETE FROM pr_commits WHERE pr_id = $1', [PR_ID]);
    await client.query('DELETE FROM pull_requests WHERE id = $1', [PR_ID]);
    await client.query('DELETE FROM projects WHERE id = $1', [PROJECT_ID]);

    await client.query(
      `INSERT INTO projects (id,display_name,git_remote,cwd_hint)
       VALUES ($1,$2,$3,$4)`,
      [PROJECT_ID, 'G1 PR Linkage Fixture', 'https://github.com/lathe-fixture/g1-pr-linkage.git', null],
    );
    await client.query(
      `INSERT INTO pull_requests (
         id,project_id,number,node_id,title,body,state,url,author_login,head_ref_name,head_sha,base_ref_name,
         additions,deletions,changed_files,review_count,reviews,created_at,updated_at,merged_at
       )
       VALUES ($1,$2,1,$3,$4,$5,'open',$6,'fixture-user',$7,$8,'main',12,3,2,1,$9::jsonb,$10,$10,NULL)`,
      [
        PR_ID,
        PROJECT_ID,
        'fixture-node-1',
        'G1 fixture PR: SHA and branch linkage',
        'Synthetic PR used by Lathe acceptance verification.',
        'https://github.com/lathe-fixture/g1-pr-linkage/pull/1',
        BRANCH,
        SHA,
        JSON.stringify([{ state: 'APPROVED', author: { login: 'reviewer' }, body: 'fixture review', submittedAt: '2026-06-11T00:00:00Z' }]),
        '2026-06-11T00:00:00Z',
      ],
    );
    await client.query('INSERT INTO pr_commits (pr_id,sha,committed_at) VALUES ($1,$2,$3)', [
      PR_ID,
      SHA,
      '2026-06-11T00:00:00Z',
    ]);

    for (const session of [
      { id: SHA_SESSION, title: 'Fixture session linked by SHA', branch: 'different-branch' },
      { id: BRANCH_SESSION, title: 'Fixture session linked by branch fallback', branch: BRANCH },
    ]) {
      await client.query(
        `INSERT INTO sessions (
           id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,
           edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,cost_usd,summary,seq
         )
         VALUES ($1,$2,$3,$4,'codex','<synthetic>','done',$5,$5,0,1,0,0,0,0,0,0,0,0,$6,$7,NULL,'fixture',900001)`,
        [
          session.id,
          PROJECT_ID,
          'G1 PR Linkage Fixture',
          session.title,
          '2026-06-11 00:00:00',
          session.branch,
          session.id === SHA_SESSION ? 1 : 0,
        ],
      );
      await client.query(
        `INSERT INTO transcript_events (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
         VALUES ($1,$2,1,'00:00:00','user_message','user',$3,$4,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`,
        [`${session.id}_1`, session.id, session.title, session.title],
      );
    }
    await client.query(
      `INSERT INTO session_commits (session_id,sha,event_id,source)
       VALUES ($1,$2,$3,'fixture')`,
      [SHA_SESSION, SHA, `${SHA_SESSION}_1`],
    );

    const links = (
      await client.query<{ session_id: string; link_method: string }>(
        `SELECT session_id, link_method
           FROM session_pull_requests
          WHERE pr_id = $1
          ORDER BY session_id, link_method`,
        [PR_ID],
      )
    ).rows;
    await client.query('COMMIT');

    console.log('================ Lathe PR linkage fixture verification ================');
    for (const link of links) console.log(`  - ${link.session_id}: ${link.link_method}`);
    console.log('=======================================================================');

    const shaLinked = links.some((link) => link.session_id === SHA_SESSION && link.link_method === 'sha');
    const branchLinked = links.some((link) => link.session_id === BRANCH_SESSION && link.link_method === 'branch');
    if (!shaLinked) throw new Error('SHA join fixture session did not link');
    if (!branchLinked) throw new Error('branch fallback fixture session did not link');
    console.log('VERDICT: GREEN — SHA join and branch fallback both link correctly.');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[verify-pr-links] failed: ${(error as Error).message}`);
  process.exit(1);
});
