import * as fs from 'node:fs';
import * as path from 'node:path';
import { isFindingKind, parseStoredAnalysis } from '@lathe/domain';
import { queryRows } from '../../lib/postgres';
import {
  PHENOMENON_LINT_PATTERNS,
  shorten,
  type AnalystCandidate,
  type KnownIncident,
  type KnownIncidentFile,
  type SmokeResult,
} from './common';
import { runAnalyst } from './orchestration';
import { deleteFindings, verifyNotifyTrigger, verifyScope } from './smoke-fixtures';
import { assertAnalysisGrounded } from './analysis';

const KNOWN_INCIDENT_INSIGHTS: Record<string, Array<{ label: string; any: RegExp[] }>> = {
  'cost-opus-prefix-overcount': [
    { label: 'prefix/accounting mechanism', any: [/prefix/i, /キャッシュ/, /cached/i] },
    { label: 'overcount magnitude', any: [/3\s*(x|倍)/i, /過大計上/, /overcount/i] },
    { label: 'cost/token impact', any: [/cost/i, /token/i, /計上/, /単価/] },
  ],
  'e2e-data-dependent-flake': [
    { label: 'data-dependent mechanism', any: [/データ依存/, /data[- ]dependent/i, /selected data/i] },
    { label: 'non-deterministic result', any: [/flake/i, /flaky/i, /same test command can change/i] },
  ],
  'next-dev-port-collision': [
    { label: 'port collision', any: [/EADDRINUSE/i, /address already in use/i, /port .*occupied/i, /occupied port/i, /3210/] },
    {
      label: 'environment not product failure',
      any: [
        /environment|runtime|setup|local process|dev-server|occupied port/i,
        /rather than product|not .*product|product or harness-code behavior|not a Lathe product fix/i,
      ],
    },
  ],
  'tasks-13-fixture-self-sufficiency': [
    { label: 'fixture-only path', any: [/自己充足/, /fixture/i, /self-contained/i, /self-contained fixture/i] },
    { label: 'real-data absence', any: [/実データ.*0\s*行/, /real-data/i, /0\s*rows?/i, /empty .*link/i] },
  ],
  'observation-ingest-bisection-accident': [
    { label: 'binary framing', any: [/二分法/, /binary framing/i, /false dichotomy/i] },
    { label: 'existence proof', any: [/存在証明/, /existence proof/i, /observed working/i] },
  ],
};

export async function runAnalystSmoke(): Promise<SmokeResult> {
  const incidents = loadKnownIncidents();
  await validateKnownIncidents(incidents);
  const createdIds: number[] = [];
  const recall: SmokeResult['recall'] = [];
  try {
    const seedSessionIds = [...new Set(incidents.map((incident) => incident.session_id))];
    for (const candidate of ['rules-v1', 'llm-v1', 'hybrid-v1'] as AnalystCandidate[]) {
      const result = await runAnalyst({ candidate, sessionIds: seedSessionIds, source: 'smoke', maxLlmSessions: seedSessionIds.length });
      createdIds.push(...result.findings.filter((item) => item.created && item.findingId).map((item) => item.findingId!));
      const item = await queryRecall(candidate, incidents);
      recall.push({ candidate, ...item, skipped: result.skipped ? result.skipReason : undefined });
      console.log(`[analyst:smoke] ${candidate} recall=${item.found}/${item.total}${result.skipped ? ` skipped=${result.skipReason}` : ''}`);
    }

    await assertPhenomenonLint();
    await assertEvidenceRequired();
    await assertAnalysisGrounded(seedSessionIds);
    await assertKnownIncidentInsights(incidents);
    await assertRulesIdempotency(seedSessionIds, createdIds);
    await assertLlmNoProviderSkip(seedSessionIds[0]);

    createdIds.push(...(await verifyScope()));
    await verifyNotifyTrigger();
  } finally {
    await deleteFindings(createdIds);
  }
  return { ok: true, recall, createdFindingsCleaned: createdIds.length };
}

function knownIncidentsPath(): string {
  let current = process.cwd();
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, 'spec', 'known-incidents.json');
    if (fs.existsSync(candidate)) return candidate;
    current = path.dirname(current);
  }
  return path.resolve(process.cwd(), '..', '..', 'spec', 'known-incidents.json');
}

function loadKnownIncidents(): KnownIncident[] {
  const file = knownIncidentsPath();
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as KnownIncidentFile;
  if (!Array.isArray(parsed.incidents)) throw new Error('spec/known-incidents.json missing incidents array');
  for (const incident of parsed.incidents) {
    if (!isFindingKind(incident.expected_kind)) throw new Error(`known incident ${incident.id} has invalid kind`);
  }
  return parsed.incidents;
}

async function validateKnownIncidents(incidents: KnownIncident[]): Promise<void> {
  let matched = 0;
  for (const incident of incidents) {
    const sessionRows = await queryRows<{ id: string; title: string; cost_usd: number | null; runner: string }>(
      'SELECT id,title,cost_usd,runner FROM sessions WHERE id = $1',
      [incident.session_id],
    );
    const session = sessionRows[0];
    if (!session || !matchesKnownIncidentSession(session, incident)) continue;
    if (!(await matchesKnownIncidentEvents(incident))) continue;
    if (incident.conditions.min_cost_multiplier && !(await matchesCostMultiplier(session, incident))) continue;
    matched++;
  }
  if (matched < 5) throw new Error(`known incident seeds are not grounded in the current DB: matched ${matched}/5 minimum`);
}

function matchesKnownIncidentSession(
  session: { title: string },
  incident: KnownIncident,
): boolean {
  return !incident.conditions.title_contains || session.title.includes(incident.conditions.title_contains);
}

async function matchesKnownIncidentEvents(incident: KnownIncident): Promise<boolean> {
  for (const needle of incident.conditions.event_contains ?? []) {
    const found = await queryRows<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM transcript_events
        WHERE session_id = $1
          AND (COALESCE(title,'') || ' ' || COALESCE(body,'') || ' ' || COALESCE(command,'')) ILIKE $2`,
      [incident.session_id, `%${needle}%`],
    );
    if ((found[0]?.n ?? 0) <= 0) return false;
  }
  return true;
}

async function matchesCostMultiplier(
  session: { cost_usd: number | null; runner: string },
  incident: KnownIncident,
): Promise<boolean> {
  const rows = await queryRows<{ median: number | null; n: number }>(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd)::float8 AS median,
            COUNT(cost_usd)::int AS n
       FROM sessions
      WHERE runner = $1
        AND cost_usd IS NOT NULL`,
    [session.runner],
  );
  const median = rows[0]?.median;
  return session.cost_usd != null && median != null && session.cost_usd >= median * incident.conditions.min_cost_multiplier!;
}

async function queryRecall(candidate: AnalystCandidate, incidents: KnownIncident[]): Promise<{ found: number; total: number }> {
  let found = 0;
  for (const incident of incidents) {
    const rows = await queryRows<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM findings f
         JOIN finding_evidence fe ON fe.finding_id = f.id
        WHERE f.analyst = $1
          AND f.kind = $2
          AND (fe.session_id = $3 OR fe.subject_id = $3)`,
      [candidate, incident.expected_kind, incident.session_id],
    );
    if ((rows[0]?.n ?? 0) > 0) found++;
  }
  return { found, total: incidents.length };
}

async function countCandidateFindings(candidate: AnalystCandidate, sessionIds: string[]): Promise<number> {
  if (!sessionIds.length) return 0;
  const rows = await queryRows<{ n: number }>(
    `SELECT COUNT(DISTINCT f.id)::int AS n
       FROM findings f
       JOIN finding_evidence fe ON fe.finding_id = f.id
      WHERE f.analyst = $1
        AND (fe.session_id = ANY($2::text[]) OR fe.subject_id = ANY($2::text[]))`,
    [candidate, sessionIds],
  );
  return rows[0]?.n ?? 0;
}

async function assertPhenomenonLint(): Promise<void> {
  const rows = await queryRows<{ id: number; body: string }>(
    `SELECT id,body
       FROM findings
      WHERE analyst = ANY($1::text[])`,
    [['rules-v1', 'llm-v1', 'hybrid-v1']],
  );
  const bad = rows.filter((row) => PHENOMENON_LINT_PATTERNS.some((pattern) => pattern.test(row.body)));
  if (bad.length) throw new Error(`phenomenon-level lint failed for finding ids: ${bad.map((row) => row.id).join(', ')}`);
}

async function assertEvidenceRequired(): Promise<void> {
  const rows = await queryRows<{ id: number }>(
    `SELECT f.id
       FROM findings f
       LEFT JOIN finding_evidence fe ON fe.finding_id = f.id
      WHERE f.analyst = ANY($1::text[])
      GROUP BY f.id
     HAVING COUNT(fe.id) = 0`,
    [['rules-v1', 'llm-v1', 'hybrid-v1']],
  );
  if (rows.length) throw new Error(`findings without evidence: ${rows.map((row) => row.id).join(', ')}`);
}

async function assertRulesIdempotency(seedSessionIds: string[], createdIds: number[]): Promise<void> {
  const before = await countCandidateFindings('rules-v1', seedSessionIds);
  const idempotent = await runAnalyst({ candidate: 'rules-v1', sessionIds: seedSessionIds, source: 'smoke' });
  createdIds.push(...idempotent.findings.filter((item) => item.created && item.findingId).map((item) => item.findingId!));
  const after = await countCandidateFindings('rules-v1', seedSessionIds);
  if (after !== before) throw new Error(`rules-v1 idempotency changed finding count for seed sessions: ${before} -> ${after}`);
}

async function assertLlmNoProviderSkip(sessionId: string): Promise<void> {
  const skip = await runAnalyst({
    candidate: 'llm-v1',
    sessionIds: [sessionId],
    source: 'smoke',
    llmProviderMode: 'none',
  });
  if (!skip.skipped || !skip.logs.join('\n').includes('skip')) throw new Error('llm-v1 no-provider path did not skip cleanly');
}

function analysisInsightText(row: {
  title: string;
  body: string;
  analysis: string | Record<string, unknown> | null;
  evidence_text: string | null;
}): string {
  const analysis = parseStoredAnalysis(row.analysis);
  return [row.title, row.body, analysis?.causeHypothesis, analysis?.agentIntent, analysis?.impact, row.evidence_text]
    .filter(Boolean)
    .join('\n');
}

function matchesExpectedInsights(text: string, incidentId: string): boolean {
  const requirements = KNOWN_INCIDENT_INSIGHTS[incidentId];
  if (!requirements) return true;
  return requirements.every((requirement) => requirement.any.some((pattern) => pattern.test(text)));
}

async function assertKnownIncidentInsights(incidents: KnownIncident[]): Promise<void> {
  const bad: string[] = [];
  for (const incident of incidents) {
    const rows = await knownIncidentInsightRows(incident);
    const hybridRows = rows.filter((row) => row.analyst === 'hybrid-v1');
    if (!hybridRows.length) {
      bad.push(`${incident.id}: hybrid-v1 produced no matching finding`);
      continue;
    }
    if (!hybridRows.some((row) => matchesExpectedInsights(analysisInsightText(row), incident.id))) {
      bad.push(`${incident.id}: hybrid-v1 analysis missed expected insight; candidates=${hybridRows.map((row) => `#${row.id} ${shorten(analysisInsightText(row), 260)}`).join(' || ')}`);
    }
  }
  if (bad.length) throw new Error(`known-incident insight smoke failed: ${bad.join('; ')}`);
}

async function knownIncidentInsightRows(incident: KnownIncident): Promise<Array<{
  id: number;
  analyst: AnalystCandidate;
  title: string;
  body: string;
  analysis: string | Record<string, unknown> | null;
  evidence_text: string | null;
}>> {
  return queryRows(
    `SELECT f.id,
            f.analyst,
            f.title,
            f.body,
            f.analysis,
            string_agg(DISTINCT concat_ws(' ', s.title, e.title, e.command, e.body, fe.note), ' ') AS evidence_text
       FROM findings f
       JOIN finding_evidence fe ON fe.finding_id = f.id
       LEFT JOIN sessions s ON s.id = COALESCE(fe.session_id, CASE WHEN fe.subject_kind = 'session' THEN fe.subject_id END)
       LEFT JOIN transcript_events e
         ON e.id = fe.subject_id
         OR (e.session_id = fe.session_id AND fe.locator ? 'seq' AND (fe.locator->>'seq') ~ '^[0-9]+$' AND e.seq = (fe.locator->>'seq')::int)
      WHERE f.analyst = ANY($1::text[])
        AND f.kind = $2
        AND (fe.session_id = $3 OR fe.subject_id = $3)
      GROUP BY f.id, f.analyst, f.title, f.body, f.analysis
      ORDER BY f.analyst ASC, f.id ASC`,
    [['llm-v1', 'hybrid-v1'], incident.expected_kind, incident.session_id],
  );
}
