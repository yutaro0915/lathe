import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getPool, queryRows } from '../../lib/postgres';
import type { IngestNotifyPayload } from '../ingest/notify';
import { runAnalyst } from './orchestration';

export async function deleteFindings(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await getPool().query('DELETE FROM findings WHERE id = ANY($1::int[])', [ids]);
}

export async function deleteSyntheticSessions(sessionIds: string[], projectIds: string[]): Promise<void> {
  if (!sessionIds.length) return;
  await getPool().query(
    `DELETE FROM findings
      WHERE id IN (
        SELECT f.id
          FROM findings f
          JOIN finding_evidence fe ON fe.finding_id = f.id
         WHERE fe.session_id = ANY($1::text[])
            OR fe.subject_id = ANY($1::text[])
      )`,
    [sessionIds],
  );
  await getPool().query(
    `DELETE FROM event_files
      WHERE event_id IN (SELECT id FROM transcript_events WHERE session_id = ANY($1::text[]))`,
    [sessionIds],
  );
  await getPool().query('DELETE FROM attributions WHERE event_id IN (SELECT id FROM transcript_events WHERE session_id = ANY($1::text[]))', [sessionIds]);
  await getPool().query('DELETE FROM diff_hunks WHERE file_id IN (SELECT id FROM changed_files WHERE session_id = ANY($1::text[]))', [sessionIds]);
  await getPool().query('DELETE FROM changed_files WHERE session_id = ANY($1::text[])', [sessionIds]);
  await getPool().query('DELETE FROM transcript_events WHERE session_id = ANY($1::text[])', [sessionIds]);
  await getPool().query('DELETE FROM session_commits WHERE session_id = ANY($1::text[])', [sessionIds]);
  await getPool().query('DELETE FROM annotations WHERE session_id = ANY($1::text[])', [sessionIds]);
  await getPool().query('DELETE FROM sessions WHERE id = ANY($1::text[])', [sessionIds]);
  if (projectIds.length) await getPool().query('DELETE FROM projects WHERE id = ANY($1::text[])', [projectIds]);
}

export async function verifyScope(): Promise<number[]> {
  const created: number[] = [];
  const sessionId = `analyst-scope-${process.pid}-${Date.now()}`;
  const otherId = `analyst-scope-other-${process.pid}-${Date.now()}`;
  const projectId = `analyst-smoke:scope:${process.pid}`;
  await insertSyntheticFailureSession(sessionId, projectId);
  await insertSyntheticFailureSession(otherId, projectId);
  try {
    await verifySessionScope(sessionId, created);
    await verifyTurnScope(sessionId, created);
    return created;
  } finally {
    await deleteSyntheticSessions([sessionId, otherId], [projectId]);
  }
}

export async function verifyNotifyTrigger(): Promise<void> {
  const sessionId = `analyst-notify-${process.pid}-${Date.now()}`;
  const projectId = `analyst-smoke:notify:${process.pid}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lathe-analyst-notify-'));
  const previousAllowedRoots = process.env.LATHE_NOTIFY_ALLOWED_ROOTS;
  try {
    const transcript = writeSyntheticClaudeTranscript(dir, sessionId);
    process.env.LATHE_NOTIFY_ALLOWED_ROOTS = dir;
    const payload: IngestNotifyPayload = {
      agent: 'claude-code',
      session_id: sessionId,
      transcript_path: transcript,
      cwd: dir,
      project_id: projectId,
      event: 'Stop',
    };
    const { ingestNotify } = await import('../ingest/notify');
    const started = Date.now();
    const result = await ingestNotify(payload);
    const elapsed = Date.now() - started;
    if (result.sessionId !== sessionId) throw new Error('notify smoke ingested the wrong session');
    if (elapsed > 2500) throw new Error(`notify response looked blocked by analyst work: ${elapsed}ms`);
    await waitForNotifyFinding(sessionId);
  } finally {
    process.env.LATHE_NOTIFY_ALLOWED_ROOTS = previousAllowedRoots;
    await deleteSyntheticSessions([sessionId], [projectId]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function insertSyntheticFailureSession(sessionId: string, projectId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO projects (id,display_name)
     VALUES ($1,$1)
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [projectId],
  );
  await getPool().query(
    `INSERT INTO sessions (id,project_id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,cost_usd,summary,harness_version_id,seq)
     VALUES ($1,$2,$2,'Analyst scope smoke','codex','gpt-5.5','failed','2026-06-12 00:00:00','2026-06-12 00:00:05',5000,3,3,0,3,0,3,0,0,0,'loop/16-analyst-probes',0,0.01,'synthetic analyst smoke',NULL,-916)`,
    [sessionId, projectId],
  );
  for (let seq = 1; seq <= 3; seq++) {
    await getPool().query(
      `INSERT INTO transcript_events (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
       VALUES ($1,$2,$3,'00:00:00','test','assistant','npm test','exit 1',NULL,'npm test',1,100,NULL,NULL,$4,NULL)`,
      [`${sessionId}_${seq}`, sessionId, seq, JSON.stringify({ tool: 'exec_command' })],
    );
  }
}

async function verifySessionScope(sessionId: string, created: number[]): Promise<void> {
  const before = await ruleFindingCountsBySession();
  const result = await runAnalyst({ candidate: 'rules-v1', sessionId, source: 'smoke' });
  created.push(...createdFindingIds(result.findings));
  const after = await ruleFindingCountsBySession();
  const beforeMap = new Map(before.map((row) => [row.session_id, row.n]));
  for (const row of after) {
    const delta = row.n - (beforeMap.get(row.session_id) ?? 0);
    if (delta > 0 && row.session_id !== sessionId) throw new Error(`--session leaked findings into ${row.session_id}`);
  }
  if (!result.findings.some((item) => item.primarySessionId === sessionId)) throw new Error('--session produced no scoped finding');
}

async function verifyTurnScope(sessionId: string, created: number[]): Promise<void> {
  const turnResult = await runAnalyst({ candidate: 'rules-v1', turn: { sessionId, seq: 2 }, source: 'smoke' });
  created.push(...createdFindingIds(turnResult.findings));
  if (!turnResult.findings.some((item) => item.primarySessionId === sessionId)) throw new Error('--turn produced no scoped finding');
  const badTurn = await queryRows<{ id: number }>(
    `SELECT f.id
       FROM findings f
       JOIN finding_evidence fe ON fe.finding_id = f.id
      WHERE f.id = ANY($1::int[])
        AND (fe.session_id <> $2 OR COALESCE((fe.locator->>'seq')::int, -1) <> 2)`,
    [turnResult.findings.map((item) => item.findingId).filter(Boolean), sessionId],
  );
  if (badTurn.length) throw new Error('--turn created evidence outside the selected turn');
}

function createdFindingIds(findings: Array<{ created?: boolean; findingId?: number }>): number[] {
  return findings.filter((item) => item.created && item.findingId).map((item) => item.findingId!);
}

async function ruleFindingCountsBySession(): Promise<Array<{ session_id: string | null; n: number }>> {
  return queryRows<{ session_id: string | null; n: number }>(
    `SELECT fe.session_id,COUNT(*)::int AS n
       FROM findings f
       JOIN finding_evidence fe ON fe.finding_id = f.id
      WHERE f.analyst = 'rules-v1'
      GROUP BY fe.session_id`,
  );
}

function writeSyntheticClaudeTranscript(dir: string, sessionId: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const records: unknown[] = [syntheticUserRecord(dir, sessionId)];
  for (let i = 1; i <= 3; i++) records.push(syntheticAssistantRecord(sessionId, i), syntheticToolResultRecord(sessionId, i));
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return file;
}

function syntheticUserRecord(dir: string, sessionId: string): Record<string, unknown> {
  return {
    type: 'user',
    sessionId,
    timestamp: '2026-06-12T00:00:00.000Z',
    cwd: dir,
    gitBranch: 'loop/16-analyst-probes',
    message: { content: 'run the tests' },
  };
}

function syntheticAssistantRecord(sessionId: string, i: number): Record<string, unknown> {
  return {
    type: 'assistant',
    sessionId,
    timestamp: `2026-06-12T00:00:0${i}.000Z`,
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: [{ type: 'tool_use', id: `toolu_${i}`, name: 'Bash', input: { command: 'npm test' } }],
    },
  };
}

function syntheticToolResultRecord(sessionId: string, i: number): Record<string, unknown> {
  return {
    type: 'user',
    sessionId,
    timestamp: `2026-06-12T00:00:0${i + 3}.000Z`,
    message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, is_error: true, content: 'exit 1' }] },
  };
}

async function waitForNotifyFinding(sessionId: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const rows = await queryRows<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM findings f
         JOIN finding_evidence fe ON fe.finding_id = f.id
        WHERE f.analyst = 'rules-v1'
          AND (fe.session_id = $1 OR fe.subject_id = $1)`,
      [sessionId],
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('notify did not schedule rules-v1 finding for the notified session');
}
