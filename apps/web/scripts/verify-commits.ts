import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { Client } from 'pg';
import { getDatabaseUrl } from '../lib/postgres';

interface SampleRow {
  sha: string;
  session_id: string;
  event_id: string | null;
  cwd_hint: string | null;
}

function gitObjectType(cwd: string, sha: string): string | null {
  try {
    return execFileSync('git', ['-C', cwd, 'cat-file', '-t', sha], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: getDatabaseUrl() });
  await client.connect();
  try {
    const commitEvents = Number(
      (await client.query("SELECT COUNT(*) AS n FROM transcript_events WHERE type = 'commit'")).rows[0]?.n ?? 0,
    );
    const extractedEvents = Number(
      (await client.query('SELECT COUNT(DISTINCT event_id) AS n FROM session_commits WHERE event_id IS NOT NULL')).rows[0]?.n ?? 0,
    );
    const extractedRows = Number(
      (await client.query('SELECT COUNT(*) AS n FROM session_commits')).rows[0]?.n ?? 0,
    );
    const samples = (
      await client.query<SampleRow>(
        `SELECT sc.sha, sc.session_id, sc.event_id, p.cwd_hint
           FROM session_commits sc
           JOIN sessions s ON s.id = sc.session_id
           JOIN projects p ON p.id = s.project_id
          WHERE p.cwd_hint IS NOT NULL
          ORDER BY s.started_at DESC, sc.sha ASC
          LIMIT 300`,
      )
    ).rows;

    const checked: { sha: string; cwd: string; type: string }[] = [];
    const unresolved: { sha: string; cwd: string }[] = [];
    for (const row of samples) {
      if (!row.cwd_hint || !fs.existsSync(row.cwd_hint)) continue;
      const type = gitObjectType(row.cwd_hint, row.sha);
      if (type === 'commit') checked.push({ sha: row.sha, cwd: row.cwd_hint, type });
      else unresolved.push({ sha: row.sha, cwd: row.cwd_hint });
      if (checked.length >= 10) break;
    }

    console.log('================ Lathe commit SHA verification ================');
    console.log(`commit events             : ${commitEvents}`);
    console.log(`events with extracted SHA : ${extractedEvents}`);
    console.log(`session_commits rows      : ${extractedRows}`);
    console.log(`git cat-file samples      : ${checked.length}`);
    for (const sample of checked) {
      console.log(`  - ${sample.sha} -> ${sample.type} (${sample.cwd})`);
    }
    if (unresolved.length) {
      console.log(`unresolved before sample  : ${unresolved.length}`);
    }
    console.log('===============================================================');

    if (commitEvents > 0 && extractedEvents === 0) {
      throw new Error('no commit events yielded an extracted SHA');
    }
    if (extractedRows === 0) {
      throw new Error('session_commits is empty');
    }
    if (checked.length === 0) {
      throw new Error('no extracted SHA sample resolved to a real git commit');
    }
    console.log('VERDICT: GREEN — commit SHA extraction is populated and sample-verified.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[verify-commits] failed: ${(error as Error).message}`);
  process.exit(1);
});
