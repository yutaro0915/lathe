import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Built } from './built';

export interface InsertCounts {
  sessions: number;
  events: number;
  changedFiles: number;
  hunks: number;
  attributions: number;
  eventFiles: number;
  annotations: number;
}

export function resetDatabase(dbPath: string, schemaPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  return db;
}

export function insertBuilt(db: DatabaseSync, built: Built[]): InsertCounts {
  const insSession = db.prepare(
    `INSERT INTO sessions (id,project,title,runner,model,status,started_at,ended_at,duration_ms,turn_count,tool_count,edit_count,bash_count,subagent_count,error_count,token_usage,token_in,token_out,git_branch,commit_count,cost_usd,summary,seq)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insEvent = db.prepare(
    `INSERT INTO transcript_events (id,session_id,seq,ts,type,actor,title,body,file_path,command,exit_code,duration_ms,token_usage,subagent,meta,parent_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insFile = db.prepare(
    `INSERT INTO changed_files (id,session_id,path,status,additions,deletions,language,seq) VALUES (?,?,?,?,?,?,?,?)`,
  );
  const insHunk = db.prepare(`INSERT INTO diff_hunks (id,file_id,seq,header,content) VALUES (?,?,?,?,?)`);
  const insAttr = db.prepare(`INSERT INTO attributions (id,hunk_id,event_id,confidence,method,note) VALUES (?,?,?,?,?,?)`);
  const insEvFile = db.prepare(`INSERT INTO event_files (event_id,path,role) VALUES (?,?,?)`);
  const insAnn = db.prepare(`INSERT INTO annotations (session_id,at_seq,kind,note) VALUES (?,?,?,?)`);

  const validEventIds = new Set<string>();
  for (const b of built) for (const e of b.events) validEventIds.add(e.id);

  const counts: InsertCounts = { sessions: built.length, events: 0, changedFiles: 0, hunks: 0, attributions: 0, eventFiles: 0, annotations: 0 };
  db.exec('BEGIN');
  for (const b of built) {
    const s = b.session;
    insSession.run(s.id, s.project, s.title, s.runner, s.model, s.status, s.started_at, s.ended_at, s.duration_ms, s.turn_count, s.tool_count, s.edit_count, s.bash_count, s.subagent_count, s.error_count, s.token_usage, s.token_in, s.token_out, s.git_branch, s.commit_count, s.cost_usd, s.summary, s.seq);
    for (const e of b.events) {
      insEvent.run(e.id, e.session_id, e.seq, e.ts, e.type, e.actor, e.title, e.body, e.file_path, e.command, e.exit_code, e.duration_ms, e.token_usage, e.subagent, e.meta, e.parent_id ?? null);
      counts.events++;
    }
    for (const f of b.changedFiles) {
      insFile.run(f.id, f.session_id, f.path, f.status, f.additions, f.deletions, f.language, f.seq);
      counts.changedFiles++;
    }
    for (const h of b.hunks) {
      insHunk.run(h.id, h.file_id, h.seq, h.header, h.content);
      counts.hunks++;
    }
    for (const a of b.attributions) {
      const eventId = a.event_id && validEventIds.has(a.event_id) ? a.event_id : null;
      insAttr.run(a.id, a.hunk_id, eventId, a.confidence, a.method, a.note);
      counts.attributions++;
    }
    for (const ef of b.eventFiles) {
      if (validEventIds.has(ef.event_id)) {
        insEvFile.run(ef.event_id, ef.path, ef.role);
        counts.eventFiles++;
      }
    }
    for (const an of b.annotations) {
      insAnn.run(an.session_id, an.at_seq, an.kind, an.note);
      counts.annotations++;
    }
  }
  db.exec('COMMIT');
  return counts;
}
