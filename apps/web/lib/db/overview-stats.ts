import type {
  FileStat,
  FindingKindCounts,
  ProjectSessionRef,
  ProjectStat,
  StatsBundle,
} from '../types';
import { queryRows } from '../db.query';
import { type FindingEvidenceRow, parseLocator } from './finding-rows';

function deriveProjectKey(path: string, repoBasename: string): string {
  const marker = `/${repoBasename}/`;
  const idx = repoBasename ? path.indexOf(marker) : -1;
  if (idx < 0) {
    if (path.includes('/.claude/')) return '(.claude config)';
    return '(external)';
  }
  const rel = path.slice(idx + marker.length);
  const segs = rel.split('/').filter(Boolean);
  if (segs.length <= 1) return '(repo root)';
  if (segs[0] === 'projects' && segs.length >= 2) return `projects/${segs[1]}`;
  return segs[0];
}

interface StatSessionRow {
  id: string;
  title: string;
  project: string;
  model: string | null;
  duration_ms: number | null;
  token_usage: number;
  cost_usd: number | null;
  error_count: number;
}

// The per-project rollup ONLY — the just-the-projects slice of getStats, used by
// the session viewer's sidebar project picker (issue #8). The full getStats also
// runs 5 extra GROUP BY aggregates (skills / subagents / memory / hooks / models)
// and a top-60 file-stat pass, none of which the viewer renders; computing those
// on every cross-session navigation was wasted server work. This shares the same
// sessions + changed_files scan and project-grouping logic, nothing more.
export async function getProjectStats(): Promise<ProjectStat[]> {
  const [sessions, fileRows] = await Promise.all([
    queryRows<StatSessionRow>(
      'SELECT id, title, project, model, duration_ms, token_usage, cost_usd, error_count FROM sessions ORDER BY seq ASC',
    ),
    queryRows<{ session_id: string; path: string; additions: number; deletions: number }>(
      'SELECT session_id, path, additions, deletions FROM changed_files',
    ),
  ]);
  return buildProjectStats(sessions, fileRows);
}

// Shared project-grouping pass (used by getProjectStats and getStats). For each
// session, attribute it to the project that owns the most of its changed files,
// then roll the session's metrics into that project bucket.
function buildProjectStats(
  sessions: StatSessionRow[],
  fileRows: { session_id: string; path: string; additions: number; deletions: number }[],
): ProjectStat[] {
  const filesBySession = new Map<string, { path: string; additions: number; deletions: number }[]>();
  for (const f of fileRows) {
    const arr = filesBySession.get(f.session_id);
    if (arr) arr.push(f);
    else filesBySession.set(f.session_id, [f]);
  }

  const projects = new Map<string, ProjectStat>();
  const ensure = (key: string): ProjectStat => {
    let p = projects.get(key);
    if (!p) {
      p = {
        project: key,
        sessions: 0,
        durationMs: 0,
        tokens: 0,
        cost: 0,
        costKnown: false,
        files: 0,
        additions: 0,
        deletions: 0,
        errors: 0,
        sessionRefs: [],
      };
      projects.set(key, p);
    }
    return p;
  };

  for (const s of sessions) {
    const files = filesBySession.get(s.id) ?? [];
    const tally = new Map<string, { files: number; add: number; del: number }>();
    for (const f of files) {
      const k = deriveProjectKey(f.path, s.project);
      const t = tally.get(k) ?? { files: 0, add: 0, del: 0 };
      t.files += 1;
      t.add += f.additions;
      t.del += f.deletions;
      tally.set(k, t);
    }

    let primary = '(no edits)';
    let best = -1;
    for (const [k, t] of [...tally.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (t.files > best) {
        best = t.files;
        primary = k;
      }
    }
    const p = ensure(primary);
    p.sessions += 1;
    p.durationMs += s.duration_ms ?? 0;
    p.tokens += s.token_usage ?? 0;
    if (s.cost_usd != null) {
      p.cost += s.cost_usd;
      p.costKnown = true;
    }
    p.errors += s.error_count ?? 0;
    for (const t of tally.values()) {
      p.files += t.files;
      p.additions += t.add;
      p.deletions += t.del;
    }
    const ref: ProjectSessionRef = {
      id: s.id,
      title: s.title,
      model: s.model,
      durationMs: s.duration_ms,
      tokens: s.token_usage,
      cost: s.cost_usd,
      errors: s.error_count,
    };
    p.sessionRefs.push(ref);
  }

  return [...projects.values()].sort(
    (a, b) => b.cost - a.cost || b.tokens - a.tokens || b.sessions - a.sessions,
  );
}

export async function getStats(): Promise<StatsBundle> {
  const sessions = await queryRows<StatSessionRow>(
    'SELECT id, title, project, model, duration_ms, token_usage, cost_usd, error_count FROM sessions ORDER BY seq ASC',
  );
  const fileRows = await queryRows<{
    session_id: string;
    path: string;
    additions: number;
    deletions: number;
  }>('SELECT session_id, path, additions, deletions FROM changed_files');

  // per-project rollup (shared with getProjectStats — issue #8)
  const projectList = buildProjectStats(sessions, fileRows);

  const refById = new Map<string, ProjectSessionRef>();
  const projBySession = new Map<string, string>();
  for (const s of sessions) {
    refById.set(s.id, {
      id: s.id,
      title: s.title,
      model: s.model,
      durationMs: s.duration_ms,
      tokens: s.token_usage,
      cost: s.cost_usd,
      errors: s.error_count,
    });
    projBySession.set(s.id, s.project);
  }
  const fileMap = new Map<
    string,
    { path: string; project: string; add: number; del: number; sessionIds: Set<string> }
  >();
  for (const f of fileRows) {
    let fs = fileMap.get(f.path);
    if (!fs) {
      fs = {
        path: f.path,
        project: deriveProjectKey(f.path, projBySession.get(f.session_id) ?? 'LLMWiki'),
        add: 0,
        del: 0,
        sessionIds: new Set(),
      };
      fileMap.set(f.path, fs);
    }
    fs.add += f.additions;
    fs.del += f.deletions;
    fs.sessionIds.add(f.session_id);
  }
  const files: FileStat[] = [...fileMap.values()]
    .sort((a, b) => b.add + b.del - (a.add + a.del))
    .slice(0, 60)
    .map((fs) => ({
      path: fs.path,
      project: fs.project,
      sessions: fs.sessionIds.size,
      additions: fs.add,
      deletions: fs.del,
      sessionRefs: [...fs.sessionIds]
        .map((id) => refById.get(id))
        .filter((r): r is ProjectSessionRef => !!r),
    }));

  const skillRows = await queryRows<{ title: string; n: number }>(
    `SELECT title, COUNT(*)::int n
       FROM transcript_events
      WHERE type = 'skill'
      GROUP BY title
      ORDER BY n DESC
      LIMIT 40`,
  );
  const skills = skillRows.map((r) => ({
    name: r.title.replace(/^Skill\s*·\s*/, '').trim() || r.title,
    count: r.n,
  }));

  const saRows = await queryRows<{ subagent: string; n: number }>(
    `SELECT subagent, COUNT(*)::int n
       FROM transcript_events
      WHERE type = 'subagent'
        AND parent_id IS NULL
        AND subagent IS NOT NULL
      GROUP BY subagent
      ORDER BY n DESC
      LIMIT 40`,
  );
  const subagentTypes = saRows.map((r) => ({ name: r.subagent, count: r.n }));

  const memRows = await queryRows<{ file_path: string; n: number }>(
    `SELECT file_path, COUNT(*)::int n
       FROM transcript_events
      WHERE type = 'memory'
        AND file_path IS NOT NULL
      GROUP BY file_path
      ORDER BY n DESC
      LIMIT 40`,
  );
  const memory = memRows.map((r) => {
    const segs = r.file_path.split('/').filter(Boolean);
    return { name: segs.length <= 2 ? r.file_path : segs.slice(-2).join('/'), count: r.n };
  });

  const hookRows = await queryRows<{ ev: string | null; nm: string | null; n: number }>(
    `SELECT meta->>'hookEvent' ev,
            meta->>'hookName' nm,
            COUNT(*)::int n
       FROM transcript_events
      WHERE type = 'hook'
      GROUP BY meta->>'hookEvent', meta->>'hookName'
      ORDER BY n DESC
      LIMIT 40`,
  );
  const hooks = hookRows.map((r) => ({
    name: r.ev ? (r.nm && r.nm !== r.ev ? `${r.ev} (${r.nm})` : r.ev) : r.nm ?? 'hook',
    count: r.n,
  }));

  const modelRows = await queryRows<{
    model: string;
    sessions: number;
    tokens: number;
    cost: number | null;
  }>(
    `SELECT COALESCE(model, '(unknown)') model,
            COUNT(*)::int sessions,
            COALESCE(SUM(token_usage), 0)::int tokens,
            SUM(cost_usd)::float8 cost
       FROM sessions
      GROUP BY model
      ORDER BY sessions DESC`,
  );
  const models = modelRows.map((r) => ({
    name: r.model,
    sessions: r.sessions,
    tokens: r.tokens ?? 0,
    cost: r.cost,
  }));

  const totals = sessions.reduce(
    (acc, s) => ({
      sessions: acc.sessions + 1,
      durationMs: acc.durationMs + (s.duration_ms ?? 0),
      tokens: acc.tokens + (s.token_usage ?? 0),
      cost: acc.cost + (s.cost_usd ?? 0),
    }),
    { sessions: 0, durationMs: 0, tokens: 0, cost: 0 },
  );

  return { totals, projects: projectList, files, skills, subagentTypes, memory, hooks, models };
}

// Pending-findings count per session, for the Overview "要注意" panel. A finding
// is "pending" when it has no latest verdict; it "touches" a session when any of
// its evidence resolves to that session (mirrors FindingsExplorer.evidenceSessionId:
// evidence.session_id, OR a subject_id when subject_kind='session', OR a locator
// session key). Two batched queries (findings + their evidence) — no N+1.
export async function getPendingFindingsBySession(): Promise<Record<string, number>> {
  const findingRows = await queryRows<{ id: number }>(
    `WITH latest_verdict AS (
       SELECT DISTINCT ON (finding_id) finding_id
         FROM finding_verdicts
        ORDER BY finding_id, decided_at DESC, id DESC
     )
     SELECT f.id
       FROM findings f
       LEFT JOIN latest_verdict v ON v.finding_id = f.id
      WHERE v.finding_id IS NULL`,
  );
  if (findingRows.length === 0) return {};
  const pendingIds = findingRows.map((r) => r.id);

  const evidenceRows = await queryRows<FindingEvidenceRow>(
    `SELECT id, finding_id, subject_kind, session_id, locator, subject_id, note
       FROM finding_evidence
      WHERE finding_id = ANY($1::int[])`,
    [pendingIds],
  );

  // resolve each evidence row to a session id, exactly as the client does, then
  // count DISTINCT pending findings per session (so a finding with two pieces of
  // evidence in the same session counts once).
  const findingsBySession = new Map<string, Set<number>>();
  for (const row of evidenceRows) {
    const locator = parseLocator(row.locator);
    const locatorSession = ['session_id', 'sessionId', 'session']
      .map((k) => locator[k])
      .find((v): v is string => typeof v === 'string' && v.trim().length > 0);
    const sessionId =
      row.session_id ??
      (row.subject_kind === 'session' ? row.subject_id : null) ??
      locatorSession ??
      null;
    if (!sessionId) continue;
    let set = findingsBySession.get(sessionId);
    if (!set) {
      set = new Set();
      findingsBySession.set(sessionId, set);
    }
    set.add(row.finding_id);
  }

  const out: Record<string, number> = {};
  for (const [sessionId, set] of findingsBySession) out[sessionId] = set.size;
  return out;
}

export async function getFindingKindCounts(): Promise<FindingKindCounts> {
  const rows = await queryRows<{ kind: string; n: number }>(
    `SELECT kind, COUNT(*)::int n
       FROM findings
      GROUP BY kind`,
  );
  const out: FindingKindCounts = {
    failure_loop: 0,
    unattributed_diff: 0,
    excess_cost: 0,
    risky_action: 0,
  };
  for (const row of rows) {
    if (row.kind in out) out[row.kind as keyof FindingKindCounts] = row.n;
  }
  return out;
}

export async function getSessionEventCounts(): Promise<Record<string, Record<string, number>>> {
  const rows = await queryRows<{ session_id: string; type: string; n: number }>(
    `SELECT session_id, type, COUNT(*)::int n
       FROM transcript_events
      WHERE parent_id IS NULL
      GROUP BY session_id, type`,
  );
  const out: Record<string, Record<string, number>> = {};
  for (const r of rows) (out[r.session_id] ??= {})[r.type] = r.n;
  return out;
}
