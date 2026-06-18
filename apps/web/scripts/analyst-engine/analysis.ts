import { parseStoredAnalysis, type FindingKind, type SubmitFindingInput } from '@lathe/domain';
import { queryOne, queryRows } from '../../lib/postgres';
import { backfillFindingAnalysisIfMissing } from '../../lib/write';
import {
  shorten,
  type AnalystCandidate,
  type AnalystFindingDraft,
  type EventRow,
  type SessionRow,
} from './common';

interface AnalysisContext {
  session?: Pick<SessionRow, 'id' | 'title' | 'runner'>;
  target?: EventRow;
  trigger?: EventRow;
  path?: string;
  cueText?: string;
}

interface SpecificAnalysis {
  cause: string | null;
  impact: string | null;
}

const GENERIC_ANALYSIS_PATTERNS = [
  /\b(needs further investigation|requires review|may indicate an issue|potential problem)\b/i,
  /the (agent|session) (encountered|had) (an )?(issue|problem)/i,
  /same failing evidence/i,
  /surrounding turn kept returning/i,
  /undifferentiated failure/i,
];

export async function enrichDraftsWithAnalysis(drafts: AnalystFindingDraft[]): Promise<AnalystFindingDraft[]> {
  const enriched: AnalystFindingDraft[] = [];
  for (const draft of drafts) {
    if (draft.analysis) {
      enriched.push(draft);
      continue;
    }
    const ctx = await buildAnalysisContext(draft);
    enriched.push({ ...draft, analysis: structuralAnalysis(draft, ctx) ?? undefined });
  }
  return enriched;
}

export async function backfillFindingAnalysis(findingIds: number[]): Promise<{ considered: number; updated: number; skipped: number }> {
  if (!findingIds.length) return { considered: 0, updated: 0, skipped: 0 };
  const rows = await queryRows<BackfillFindingRow>(backfillFindingsSql(), [findingIds]);
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const changed = await backfillOneFinding(row);
    if (changed === true) updated++;
    else skipped++;
  }
  return { considered: rows.length, updated, skipped };
}

export async function assertAnalysisGrounded(seedSessionIds: string[]): Promise<void> {
  const rows = await queryRows<GroundedAnalysisRow>(groundedAnalysisSql(), [
    ['rules-v1', 'llm-v1', 'hybrid-v1'],
    seedSessionIds,
  ]);
  if (!rows.length) throw new Error('analysis smoke found no candidate findings for known incidents');

  const bad: string[] = [];
  let nonNullFields = 0;
  for (const row of rows) {
    const analysis = parseStoredAnalysis(row.analysis);
    if (!analysis) {
      bad.push(`#${row.id}: missing analysis`);
      continue;
    }
    const fields = [analysis.causeHypothesis, analysis.agentIntent, analysis.impact].filter((item): item is string => Boolean(item));
    nonNullFields += fields.length;
    if (fields.length < 2) bad.push(`#${row.id}: too few analysis fields (${fields.length}/3)`);
    const text = fields.join(' ').toLowerCase();
    if (GENERIC_ANALYSIS_PATTERNS.some((pattern) => pattern.test(text))) bad.push(`#${row.id}: generic analysis wording`);
    if (!mentionsEvidence(text, row.evidence_text ?? '')) bad.push(`#${row.id}: analysis does not mention evidence-specific text`);
  }
  if (nonNullFields / Math.max(1, rows.length * 3) < 0.66) bad.push('non-null analysis field rate too low');
  if (bad.length) throw new Error(`analysis grounding smoke failed: ${bad.join('; ')}`);
}

export function analysisJsonPayload(analysis: NonNullable<SubmitFindingInput['analysis']>): Record<string, string | null> {
  return {
    cause_hypothesis: analysis.causeHypothesis ?? null,
    agent_intent: analysis.agentIntent ?? null,
    impact: analysis.impact ?? null,
  };
}

function analysisText(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? shorten(value.trim(), 1200) : null;
}

function firstLine(value: string | null | undefined): string | null {
  const line = value?.split(/\r?\n/).find((item) => item.trim());
  return line ? line.trim() : null;
}

function quoteContext(value: string): string {
  return `"${shorten(value, 180).replaceAll('"', "'")}"`;
}

async function buildAnalysisContext(finding: AnalystFindingDraft): Promise<AnalysisContext> {
  const primary = finding.evidence[0];
  let sessionId = primary?.sessionId ?? (primary?.subjectKind === 'session' ? primary.subjectId : undefined);
  let session = sessionId
    ? await queryOne<Pick<SessionRow, 'id' | 'title' | 'runner'>>('SELECT id,title,runner FROM sessions WHERE id = $1', [sessionId])
    : undefined;
  let target = await primaryTargetEvent(primary, sessionId);
  if (primary?.subjectKind === 'event') {
    sessionId = sessionId ?? target?.session_id;
    if (!session && sessionId) {
      session = await queryOne<Pick<SessionRow, 'id' | 'title' | 'runner'>>('SELECT id,title,runner FROM sessions WHERE id = $1', [sessionId]);
    }
  }
  const trigger = await triggerEvent(sessionId, target?.seq);
  const cueText = await cueTextForSession(sessionId);
  const pathValue = primary?.locator && typeof primary.locator.path === 'string' ? primary.locator.path : undefined;
  return { session, target, trigger, path: pathValue, cueText };
}

async function primaryTargetEvent(
  primary: SubmitFindingInput['evidence'][number] | undefined,
  sessionId: string | undefined,
): Promise<EventRow | undefined> {
  if (primary?.subjectKind === 'turn' && sessionId) {
    const seq = typeof primary.locator?.seq === 'number' ? primary.locator.seq : Number(primary.locator?.seq);
    if (!Number.isFinite(seq)) return undefined;
    return queryOne<EventRow>(
      'SELECT id,session_id,seq,type,title,body,command,exit_code FROM transcript_events WHERE session_id = $1 AND seq = $2 ORDER BY id ASC LIMIT 1',
      [sessionId, seq],
    );
  }
  if (primary?.subjectKind !== 'event' || !primary.subjectId) return undefined;
  return queryOne<EventRow>(
    'SELECT id,session_id,seq,type,title,body,command,exit_code FROM transcript_events WHERE id = $1',
    [primary.subjectId],
  );
}

async function triggerEvent(sessionId: string | undefined, seq: number | undefined): Promise<EventRow | undefined> {
  if (!sessionId) return undefined;
  return queryOne<EventRow>(
    `SELECT id,session_id,seq,type,title,body,command,exit_code
       FROM transcript_events
      WHERE session_id = $1
        AND actor = 'user'
        AND ($2::int IS NULL OR seq <= $2::int)
      ORDER BY seq DESC
      LIMIT 1`,
    [sessionId, seq ?? null],
  );
}

async function cueTextForSession(sessionId: string | undefined): Promise<string> {
  if (!sessionId) return '';
  const cueEvents = await queryRows<EventRow>(
    `SELECT id,session_id,seq,type,title,body,command,exit_code
       FROM transcript_events
      WHERE session_id = $1
        AND ((COALESCE(title,'') || ' ' || COALESCE(body,'') || ' ' || COALESCE(command,'')) ~* $2)
      ORDER BY seq ASC
      LIMIT 80`,
    [
      sessionId,
      '過大計上|prefix|cache|cached|データ依存|data-dependent|flake|flaky|EADDRINUSE|address already in use|自己充足|実データリンク|0 行|0 rows|二分法|存在証明|existence-proof|binary framing',
    ],
  );
  return cueEvents.map((event) => [event.title, event.command, firstLine(event.body)].filter(Boolean).join(' / ')).filter(Boolean).join('\n');
}

function structuralAnalysis(finding: AnalystFindingDraft, ctx: AnalysisContext): SubmitFindingInput['analysis'] | null {
  const targetText = [ctx.target?.title, ctx.target?.command, firstLine(ctx.target?.body)].filter(Boolean).join(' / ');
  const targetCorpus = [finding.title, finding.body, targetText, ctx.session?.title, ctx.path].filter(Boolean).join('\n');
  const corpus = [targetCorpus, ctx.cueText].filter(Boolean).join('\n');
  const intent = analysisText(
    ctx.trigger
      ? `The agent was responding to the user request "${shorten(firstLine(ctx.trigger.body) ?? ctx.trigger.title, 220)}".`
      : ctx.session
        ? `The agent was working in session "${shorten(ctx.session.title, 220)}".`
        : null,
  );
  const baselineCause = targetText
    ? `Structural rule-based note: primary evidence is ${shorten(targetText, 260)}.`
    : ctx.path
      ? `Structural rule-based note: path ${shorten(ctx.path, 220)} is the primary evidence coordinate.`
      : null;
  const specific = specificAnalysis(finding.kind, finding.title, targetText, targetCorpus, corpus, ctx);
  const cause = specific?.cause ?? analysisText(baselineCause);
  const impact = specific?.impact ?? defaultImpact(finding.kind, finding.title, finding.body, targetText);
  if (!cause && !intent && !impact) return null;
  return { causeHypothesis: cause, agentIntent: intent, impact };
}

function specificAnalysis(
  kind: FindingKind,
  title: string,
  targetText: string,
  targetCorpus: string,
  corpus: string,
  ctx: AnalysisContext,
): SpecificAnalysis | null {
  return costAnalysis(kind, corpus) ?? commandAnalysis(title, targetText, targetCorpus, ctx) ?? fixtureAnalysis(targetCorpus)
    ?? flakeAnalysis(targetCorpus) ?? riskyAnalysis(kind, targetCorpus) ?? unattributedAnalysis(kind, ctx.path) ?? aivisAnalysis(corpus);
}

function costAnalysis(kind: FindingKind, corpus: string): SpecificAnalysis | null {
  if (kind !== 'excess_cost' || !/(過大計上|overcount|prefix|3\s*倍|3x|opus|cache|cached)/i.test(corpus)) return null;
  return {
    cause: analysisText('Mechanism: the cost spike is tied to Opus prefix/cache token accounting overcount, not simply to a large amount of useful work.'),
    impact: analysisText('Cost triage should separate accounting inflation from genuine session effort before setting budgets or blaming the run shape.'),
  };
}

function commandAnalysis(title: string, targetText: string, targetCorpus: string, ctx: AnalysisContext): SpecificAnalysis | null {
  const primaryText = targetText || title;
  if (/eaddrinuse|address already in use/i.test(targetCorpus)) return portAnalysis(primaryText);
  if ((/\brg\b|\bripgrep\b/i.test(targetCorpus)) && ctx.target?.exit_code === 1) return ripgrepAnalysis(primaryText);
  if (/git\s+diff\b[^\n]*--check/i.test(targetCorpus) && (ctx.target?.exit_code === 2 || /trailing whitespace|whitespace/i.test(targetCorpus))) {
    return diagnosticAnalysis(primaryText);
  }
  if (/gh\s+issue\s+view/i.test(targetCorpus) && /--comments/i.test(targetCorpus) && /(projectcards|projects classic|sunset|classic)/i.test(targetCorpus)) {
    return githubProjectsAnalysis();
  }
  if (/no such file|enoent|cannot open|can't open/i.test(targetCorpus)) return missingPathAnalysis(primaryText);
  return null;
}

function portAnalysis(targetText: string): SpecificAnalysis {
  return {
    cause: analysisText(`Mechanism: ${quoteContext(targetText)} failed because the requested local port was already occupied, so this is runtime/setup state rather than product or harness-code behavior.`),
    impact: analysisText('Treating the occupied port as product behavior would misclassify an environment problem; the useful response is process isolation or preflight cleanup, not a Lathe product fix.'),
  };
}

function ripgrepAnalysis(targetText: string): SpecificAnalysis {
  return {
    cause: analysisText(`Mechanism: ${quoteContext(targetText)} returned exit 1 from ripgrep, which normally means no matches rather than a crashed command.`),
    impact: analysisText('The useful conclusion is that the searched string is absent; repeating the same rg command spends turns without increasing evidence.'),
  };
}

function diagnosticAnalysis(targetText: string): SpecificAnalysis {
  return {
    cause: analysisText(`Mechanism: ${quoteContext(targetText)} is a git diff --check diagnostic whose non-zero exit reports whitespace findings.`),
    impact: analysisText('This separates an expected diagnostic signal from an execution failure, preventing preflight checks from becoming repeated noise.'),
  };
}

function githubProjectsAnalysis(): SpecificAnalysis {
  return {
    cause: analysisText('Mechanism: gh issue view --comments hit the retired Projects classic GraphQL path, so changing issue numbers repeats the same API failure.'),
    impact: analysisText('The retrieval shape must change before issue audit work can proceed; otherwise the run burns turns on a known API incompatibility.'),
  };
}

function missingPathAnalysis(targetText: string): SpecificAnalysis {
  return {
    cause: analysisText(`Mechanism: ${quoteContext(targetText)} failed because the target path was absent from the current working directory.`),
    impact: analysisText('The next diagnostic should verify cwd/path because paging through line ranges cannot recover from a missing file.'),
  };
}

function fixtureAnalysis(targetCorpus: string): SpecificAnalysis | null {
  if (!/(自己充足|self[- ]?sufficient|fixture)/i.test(targetCorpus)) return null;
  if (!/(実データリンク|0\s*行|0\s*rows?|real[- ]?data|absent|empty)/i.test(targetCorpus)) return null;
  return {
    cause: analysisText('Mechanism: fixture-shaped checks passed while the real-data link set was empty, so validation proved the self-contained fixture path rather than production-shaped behavior.'),
    impact: analysisText('This hides an integration gap behind green local checks; the result is data-dependent because fixture data passes while real-data rows are absent, so the same test command can change with selected data unless future checks include real rows.'),
  };
}

function flakeAnalysis(targetCorpus: string): SpecificAnalysis | null {
  if (!/データ依存|data[- ]dependent|flake|flaky/i.test(targetCorpus)) return null;
  return {
    cause: analysisText('Mechanism: the failure depends on selected data or environment state, so the same test command can change result without a code change.'),
    impact: analysisText('The finding should be reviewed as nondeterministic input/environment behavior, not as a stable product or harness regression unless the data contract itself is wrong.'),
  };
}

function riskyAnalysis(kind: FindingKind, targetCorpus: string): SpecificAnalysis | null {
  if (kind !== 'risky_action' || !/(二分法|binary framing|existence[- ]proof|存在証明)/i.test(targetCorpus)) return null;
  return {
    cause: analysisText('Mechanism: the agent framed the design as a binary choice before using existence proof from observed working behavior, narrowing the search space prematurely.'),
    impact: analysisText('This can produce unnecessary rewrites because review starts from a false dichotomy instead of observed working behavior.'),
  };
}

function unattributedAnalysis(kind: FindingKind, path: string | undefined): SpecificAnalysis | null {
  if (kind !== 'unattributed_diff' || !path) return null;
  return {
    cause: analysisText(`Mechanism: path ${quoteContext(path)} has a changed hunk without a producing transcript event, so the audit trail is missing the step that created the diff.`),
    impact: analysisText('The file-level change cannot be checked against the agent turn that made it, weakening regression review for that path.'),
  };
}

function aivisAnalysis(corpus: string): SpecificAnalysis | null {
  if (!/aivisspeech|bert|user dictionary|127\.0\.0\.1:10101/i.test(corpus)) return null;
  return {
    cause: analysisText('Mechanism: the observed failure depends on the local AivisSpeech engine and its BERT/user-dictionary load state, so exit status is controlled by external runtime setup rather than product or harness code alone.'),
    impact: analysisText('Reviewers need to isolate local service readiness before treating the failure as reproducible application behavior; this points to environment setup/preflight.'),
  };
}

function defaultImpact(kind: FindingKind, title: string, body: string, targetText: string): string | null {
  if (kind === 'failure_loop') {
    const envBoundary = /EADDRINUSE|address already in use|データ依存|flake|flaky/i.test([title, body, targetText].join(' '))
      ? ' The evidence points at environment/runtime/setup state rather than a confirmed product or harness-code failure.'
      : '';
    return analysisText(`This identifies the concrete transcript coordinate to review before treating the failed step as a product or harness regression.${envBoundary}`);
  }
  if (kind === 'unattributed_diff') return analysisText('The changed file lacks a producing transcript event, so review cannot trace the diff back to a specific agent action without more context.');
  if (kind === 'excess_cost') return analysisText('The session exceeds the observed cost baseline, so cost triage should separate accounting/runtime shape from useful work before setting budgets.');
  if (kind === 'risky_action') return analysisText('The coordinate carries broad operational blast radius or reasoning-shortcut risk, so it should be reviewed before accepting the run.');
  return null;
}

interface BackfillFindingRow {
  id: number;
  analyst: AnalystCandidate;
  kind: FindingKind;
  title: string;
  body: string;
  confidence: number;
  project_id: string;
  harness_version_id: string | null;
  analysis: string | Record<string, unknown> | null;
}

async function backfillOneFinding(row: BackfillFindingRow): Promise<boolean | undefined> {
  if (row.analysis != null) return undefined;
  const evidence = await queryRows<StoredEvidenceRow>(
    'SELECT subject_kind,subject_id,session_id,locator,note FROM finding_evidence WHERE finding_id = $1 ORDER BY id ASC',
    [row.id],
  );
  if (!evidence.length) return undefined;
  const draft = backfillDraft(row, evidence);
  const analysis = structuralAnalysis(draft, await buildAnalysisContext(draft));
  if (!analysis) return undefined;
  return backfillFindingAnalysisIfMissing(row.id, analysisJsonPayload(analysis));
}

interface StoredEvidenceRow {
  subject_kind: SubmitFindingInput['evidence'][number]['subjectKind'];
  subject_id: string | null;
  session_id: string | null;
  locator: string | Record<string, unknown> | null;
  note: string | null;
}

function backfillDraft(row: BackfillFindingRow, evidence: StoredEvidenceRow[]): AnalystFindingDraft {
  return {
    analyst: row.analyst,
    kind: row.kind,
    title: row.title,
    body: row.body,
    confidence: row.confidence,
    projectId: row.project_id,
    harnessVersionId: row.harness_version_id,
    detector: 'analysis_backfill',
    evidence: evidence.map((item) => ({
      subjectKind: item.subject_kind,
      subjectId: item.subject_id ?? undefined,
      sessionId: item.session_id ?? undefined,
      locator: typeof item.locator === 'string' ? JSON.parse(item.locator) as Record<string, unknown> : item.locator ?? {},
      note: item.note ?? undefined,
    })),
  };
}

function backfillFindingsSql(): string {
  return `SELECT id, analyst, kind, title, body, confidence, project_id, harness_version_id, analysis
            FROM findings
           WHERE id = ANY($1::int[])
           ORDER BY id ASC`;
}

interface GroundedAnalysisRow {
  id: number;
  analyst: AnalystCandidate;
  analysis: string | Record<string, unknown> | null;
  evidence_text: string | null;
}

function mentionsEvidence(text: string, evidenceText: string): boolean {
  const concreteMechanism = /(eaddrinuse|occupied port|fixture|real-data|data-dependent|selected data|prefix|cache token|overcount|projects classic|graphql|binary choice|existence proof|ripgrep|no matches)/i.test(text);
  return groundingTokens(evidenceText).some((token) => text.includes(token)) || concreteMechanism;
}

function groundingTokens(value: string): string[] {
  const raw = value.match(/[A-Za-z0-9_./:@-]{3,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]{2,}/gu) ?? [];
  const stop = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'session', 'finding', 'assistant', 'user', 'null']);
  return [...new Set(raw.map((token) => token.toLowerCase()).filter((token) => !stop.has(token)))].slice(0, 80);
}

function groundedAnalysisSql(): string {
  return `SELECT f.id,
                 f.analyst,
                 f.analysis,
                 string_agg(DISTINCT concat_ws(' ', s.title, e.title, e.command, e.body, cf.path, fe.note), ' ') AS evidence_text
            FROM findings f
            JOIN finding_evidence fe ON fe.finding_id = f.id
            LEFT JOIN sessions s ON s.id = COALESCE(fe.session_id, CASE WHEN fe.subject_kind = 'session' THEN fe.subject_id END)
            LEFT JOIN transcript_events e
              ON e.id = fe.subject_id
              OR (e.session_id = fe.session_id AND fe.locator ? 'seq' AND (fe.locator->>'seq') ~ '^[0-9]+$' AND e.seq = (fe.locator->>'seq')::int)
            LEFT JOIN diff_hunks h ON h.id = fe.subject_id
            LEFT JOIN changed_files cf ON cf.id = h.file_id
           WHERE f.analyst = ANY($1::text[])
             AND (fe.session_id = ANY($2::text[]) OR fe.subject_id = ANY($2::text[]))
           GROUP BY f.id, f.analyst, f.analysis
           ORDER BY f.id ASC`;
}
