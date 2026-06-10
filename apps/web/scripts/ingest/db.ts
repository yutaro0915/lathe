import * as fs from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import type { Built } from './built';
import { getDatabaseUrl } from '../../lib/postgres';

export interface InsertCounts {
  sessions: number;
  events: number;
  changedFiles: number;
  hunks: number;
  attributions: number;
  eventFiles: number;
  annotations: number;
}

function cleanParams(values: unknown[]): unknown[] {
  return values.map((value) => (typeof value === 'string' ? value.replace(/\u0000/g, '') : value));
}

export async function resetDatabase(schemaPath: string): Promise<Pool> {
  const pool = new Pool({ connectionString: getDatabaseUrl() });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await pool.query(fs.readFileSync(schemaPath, 'utf8'));
  return pool;
}

async function insertBuiltWithClient(client: PoolClient, built: Built[]): Promise<InsertCounts> {
  const validEventIds = new Set<string>();
  for (const b of built) for (const e of b.events) validEventIds.add(e.id);

  const counts: InsertCounts = {
    sessions: built.length,
    events: 0,
    changedFiles: 0,
    hunks: 0,
    attributions: 0,
    eventFiles: 0,
    annotations: 0,
  };

  await client.query('BEGIN');
  try {
    for (const b of built) {
      const s = b.session;
      await client.query(
        `INSERT INTO sessions (id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,cost_usd,summary,seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
        cleanParams([
          s.id,
          s.project,
          s.title,
          s.runner,
          s.model,
          s.status,
          s.started_at,
          s.ended_at,
          s.duration_ms,
          s.turn_count,
          s.tool_count,
          s.edit_count,
          s.bash_count,
          s.subagent_count,
          s.error_count,
          s.token_usage,
          s.token_in,
          s.token_out,
          s.git_branch,
          s.commit_count,
          s.cost_usd,
          s.summary,
          s.seq,
        ]),
      );

      for (const e of b.events) {
        await client.query(
          `INSERT INTO transcript_events (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          cleanParams([
            e.id,
            e.session_id,
            e.seq,
            e.ts,
            e.type,
            e.actor,
            e.title,
            e.body,
            e.file_path,
            e.command,
            e.exit_code,
            e.duration_ms,
            e.token_usage,
            e.subagent,
            e.meta,
            e.parent_id ?? null,
          ]),
        );
        counts.events++;
      }

      for (const f of b.changedFiles) {
        await client.query(
          `INSERT INTO changed_files (id,session_id,path,status,additions,deletions,language,seq)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          cleanParams([f.id, f.session_id, f.path, f.status, f.additions, f.deletions, f.language, f.seq]),
        );
        counts.changedFiles++;
      }

      for (const h of b.hunks) {
        await client.query(
          `INSERT INTO diff_hunks (id,file_id,seq,header,content)
           VALUES ($1,$2,$3,$4,$5)`,
          cleanParams([h.id, h.file_id, h.seq, h.header, h.content]),
        );
        counts.hunks++;
      }

      for (const a of b.attributions) {
        const eventId = a.event_id && validEventIds.has(a.event_id) ? a.event_id : null;
        await client.query(
          `INSERT INTO attributions (id,hunk_id,event_id,confidence,method,note)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          cleanParams([a.id, a.hunk_id, eventId, a.confidence, a.method, a.note]),
        );
        counts.attributions++;
      }

      for (const ef of b.eventFiles) {
        if (validEventIds.has(ef.event_id)) {
          await client.query(
            `INSERT INTO event_files (event_id,path,role)
             VALUES ($1,$2,$3)`,
            cleanParams([ef.event_id, ef.path, ef.role]),
          );
          counts.eventFiles++;
        }
      }

      for (const an of b.annotations) {
        await client.query(
          `INSERT INTO annotations (session_id,at_seq,kind,note)
           VALUES ($1,$2,$3,$4)`,
          cleanParams([an.session_id, an.at_seq, an.kind, an.note]),
        );
        counts.annotations++;
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  return counts;
}

export async function insertBuilt(pool: Pool, built: Built[]): Promise<InsertCounts> {
  const client = await pool.connect();
  try {
    return await insertBuiltWithClient(client, built);
  } finally {
    client.release();
  }
}
