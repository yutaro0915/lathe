import * as path from 'node:path';
import { latheMcpServer, runSession, type AdapterCommand, type McpServer, type PermissionRequest, type SessionUpdate } from '@lathe/acp-client';
import { stableJson, type FindingKind } from '@lathe/domain';
import { backfillFindingAnalysis, enrichDraftsWithAnalysis } from './analysis';
import {
  BISECTION_ACCIDENT,
  DATA_DEPENDENT_FLAKE,
  INTERNAL_ANALYST_TAG,
  RISKY_COMMAND,
  SELF_SUFFICIENT_FIXTURE,
  eventText,
  primarySessionId,
  shorten,
  type AnalystCandidate,
  type AnalystFindingDraft,
  type RunAnalystOptions,
  type RunAnalystResult,
  type SessionRow,
  type EventRow,
} from './common';
import { listEventsForSessions, listTargetSessions } from './queries';
import { runRulesCandidate } from './rules';
import { queryRows } from '../../lib/postgres';

interface SubmittedFindingRow {
  id: number;
  kind: FindingKind;
  title: string;
  session_id: string | null;
}

export async function runLlmCandidate(options: RunAnalystOptions): Promise<RunAnalystResult> {
  const digests = await buildSessionDigests(options);
  const sessionIds = digests.map((item) => item.session.id);
  const prompt = `${acpFindingInstructions('llm-v1', options.submit !== false)}

Prefer real anomalies: repeated failures, data-dependent flakes, excess cost, broad-risk commands, premature binary framing.

Session digests:
${digestText(digests)}

${mcpSubmitExample('llm-v1')}`;
  return runAcpSession({ analyst: 'llm-v1', prompt, sessionIds, options });
}

export async function runHybridCandidate(options: RunAnalystOptions): Promise<RunAnalystResult> {
  const rawRules = await runRulesCandidate('hybrid-v1', { ...options, submit: false });
  const rules = selectHybridRuleContexts(await enrichDraftsWithAnalysis(rawRules));
  if (!rules.length) {
    return {
      candidate: options.candidate,
      generated: 0,
      submitted: 0,
      created: 0,
      skipped: true,
      skipReason: 'rules produced no candidate contexts',
      findings: [],
      logs: ['skip hybrid-v1: no rule contexts'],
    };
  }
  const sessionIds = [...new Set(rules.map(primarySessionId).filter((id): id is string => Boolean(id)))];
  const prompt = `${acpFindingInstructions('hybrid-v1', options.submit !== false)}

This hybrid analyst prompt already contains final finding payloads derived from deterministic rule preselection plus deep-dive analysis instructions.
Call mcp__lathe__submit_finding exactly once for each payload below.
Use the payloads semantically as-is: do not rewrite title, body, analysis, evidence, kind, analyst, confidence, project_id, or harness_version_id.
Do not call any other tool. Do not omit a payload because another payload has the same session_id.

Payloads:
${rules.map((finding, index) => `payload_${index}=${stableJson(findingToMcpPayload(finding))}`).join('\n')}`;
  return runAcpSession({ analyst: 'hybrid-v1', prompt, sessionIds, options });
}

async function runAcpSession(input: {
  analyst: Exclude<AnalystCandidate, 'rules-v1'>;
  prompt: string;
  sessionIds: string[];
  options: RunAnalystOptions;
}): Promise<RunAnalystResult> {
  const preflight = acpPreflightResult(input.options, input.analyst);
  if (preflight) return preflight;

  const submit = input.options.submit !== false;
  const before = await querySubmittedCandidateFindings(input.analyst, input.sessionIds);
  const beforeIds = new Set(before.map((row) => row.id));
  const updates: SessionUpdate[] = [];
  try {
    const result = await runSession({
      adapter: analystAcpAdapter(),
      cwd: repoRoot(),
      mcpServers: analystMcpServers(submit),
      sessionMeta: { claudeCode: { emitRawSDKMessages: true, options: { tools: ['mcp__lathe__submit_finding'] } } },
      prompt: input.prompt,
      timeoutMs: Number(process.env.LATHE_ANALYST_ACP_TIMEOUT_MS || 180_000),
      onUpdate: (update) => {
        updates.push(update);
        debugAcpUpdate(update);
      },
      onPermission: (request) => allowPermission(request, submit),
    });
    return await acpResult(input, beforeIds, updates, result.sessionId, String(result.prompt.stopReason ?? ''));
  } catch (error) {
    const reason = shorten((error as Error).message, 600);
    return {
      candidate: input.options.candidate,
      generated: 0,
      submitted: 0,
      created: 0,
      skipped: true,
      skipReason: reason,
      findings: [],
      logs: [`skip ${input.analyst}: ACP session failed: ${reason}`],
    };
  }
}

function acpPreflightResult(
  options: RunAnalystOptions,
  analyst: Exclude<AnalystCandidate, 'rules-v1'>,
): RunAnalystResult | undefined {
  if (options.llmProviderMode === 'none') {
    return {
      candidate: options.candidate,
      generated: 0,
      submitted: 0,
      created: 0,
      skipped: true,
      skipReason: 'forced no-provider mode',
      findings: [],
      logs: [`skip ${analyst}: forced no-provider mode`],
    };
  }
  if (options.submit !== false) return undefined;
  return {
    candidate: options.candidate,
    generated: 0,
    submitted: 0,
    created: 0,
    skipped: false,
    findings: [],
    logs: [`dry-run ${analyst}: ACP submit suppressed`],
  };
}

async function acpResult(
  input: { analyst: Exclude<AnalystCandidate, 'rules-v1'>; sessionIds: string[]; options: RunAnalystOptions },
  beforeIds: Set<number>,
  updates: SessionUpdate[],
  acpSessionId: string,
  stopReason: string,
): Promise<RunAnalystResult> {
  let after = await querySubmittedCandidateFindings(input.analyst, input.sessionIds);
  const createdIds = after.filter((row) => !beforeIds.has(row.id)).map((row) => row.id);
  if (createdIds.length) {
    await backfillFindingAnalysis(createdIds);
    after = await querySubmittedCandidateFindings(input.analyst, input.sessionIds);
  }
  return submittedRowsToResult(input.options, beforeIds, after, [
    `acp provider=claude-agent-acp analyst=${input.analyst} session=${acpSessionId} updates=${updates.length} stop=${stopReason}`,
  ]);
}

function repoRoot(): string {
  return path.resolve(process.cwd(), '..', '..');
}

function analystAcpAdapter(): AdapterCommand {
  const command = process.env.LATHE_ANALYST_ACP_COMMAND || 'npx';
  const args = process.env.LATHE_ANALYST_ACP_ARGS
    ? JSON.parse(process.env.LATHE_ANALYST_ACP_ARGS) as string[]
    : ['-y', '@agentclientprotocol/claude-agent-acp@latest'];
  return { command, args, env: { LATHE_INTERNAL_ANALYST_TAG: INTERNAL_ANALYST_TAG } };
}

function analystMcpServers(submit: boolean): McpServer[] {
  const server = latheMcpServer({ repoRoot: repoRoot(), databaseUrl: process.env.DATABASE_URL });
  if ('env' in server) {
    server.env = [...server.env, { name: 'LATHE_MCP_ONLY_SUBMIT_FINDING', value: '1' }];
    if (!submit) server.env = [...server.env, { name: 'LATHE_MCP_DISABLE_SUBMIT_FINDING', value: '1' }];
  }
  return [server];
}

function permissionToolName(request: PermissionRequest): string {
  const raw = [
    request.toolCall?.name,
    request.toolCall?.toolName,
    request.toolCall?._meta && typeof request.toolCall._meta === 'object' && !Array.isArray(request.toolCall._meta)
      ? (request.toolCall._meta as Record<string, unknown>).toolName
      : undefined,
  ].find((item) => typeof item === 'string');
  return typeof raw === 'string' ? raw : '';
}

function allowPermission(request: PermissionRequest, submit: boolean) {
  const toolName = permissionToolName(request);
  if (!submit && /submit_finding/.test(toolName)) {
    const reject = request.options.find((option) => option.kind === 'reject_once' || option.kind === 'reject_always');
    return reject ? { outcome: 'selected' as const, optionId: reject.optionId } : { outcome: 'cancelled' as const };
  }
  const allow = request.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always') ?? request.options[0];
  return allow ? { outcome: 'selected' as const, optionId: allow.optionId } : { outcome: 'cancelled' as const };
}

function debugAcpUpdate(update: SessionUpdate): void {
  if (process.env.LATHE_ANALYST_DEBUG_ACP !== '1') return;
  const meta = update._meta && typeof update._meta === 'object' && !Array.isArray(update._meta)
    ? update._meta as Record<string, unknown>
    : {};
  const claude = meta.claudeCode && typeof meta.claudeCode === 'object' && !Array.isArray(meta.claudeCode)
    ? meta.claudeCode as Record<string, unknown>
    : {};
  console.error(
    `[analyst:acp] update=${String(update.sessionUpdate ?? '')} status=${String(update.status ?? '')} tool=${String(claude.toolName ?? update.toolName ?? '')}`,
  );
}

async function buildSessionDigests(options: RunAnalystOptions): Promise<Array<{ session: SessionRow; events: EventRow[] }>> {
  const target = await listTargetSessions(options);
  const maxSessions = options.sessionId || options.turn || options.sessionIds?.length ? target.length : (options.maxLlmSessions ?? 3);
  const sessions = target.slice(0, Math.max(1, maxSessions));
  const events = await listEventsForSessions(sessions.map((session) => session.id), options);
  return sessions.map((session) => ({ session, events: digestEvents(events, session.id, options) }));
}

function digestEvents(events: EventRow[], sessionId: string, options: RunAnalystOptions): EventRow[] {
  return events
    .filter((event) => event.session_id === sessionId)
    .filter((event, index) => {
      if (options.turn) return true;
      const text = eventText(event);
      return index < 12 || event.exit_code !== 0 || DATA_DEPENDENT_FLAKE.test(text) || SELF_SUFFICIENT_FIXTURE.test(text) || RISKY_COMMAND.test(text) || BISECTION_ACCIDENT.test(text);
    })
    .slice(0, 18);
}

function digestText(digests: Array<{ session: SessionRow; events: EventRow[] }>): string {
  return digests.map((digest) => `${digestHeader(digest.session)}\n${digest.events.map(digestEventLine).join('\n')}`).join('\n\n---\n\n');
}

function digestHeader(session: SessionRow): string {
  return [
    `session_id=${session.id}`,
    `title=${session.title}`,
    `runner=${session.runner}`,
    `cost_usd=${session.cost_usd ?? 'null'}`,
    `cost_threshold=${session.cost_threshold_usd}`,
    `errors=${session.error_count}`,
    `turns=${session.turn_count}`,
  ].join(' | ');
}

function digestEventLine(event: EventRow): string {
  return [
    `seq=${event.seq}`,
    `type=${event.type}`,
    `exit=${event.exit_code ?? 'null'}`,
    `title=${shorten(event.title, 100)}`,
    event.command ? `cmd=${shorten(event.command, 120)}` : '',
    event.body ? `body=${shorten(event.body, 180)}` : '',
  ].filter(Boolean).join(' | ');
}

function acpFindingInstructions(analyst: Exclude<AnalystCandidate, 'rules-v1'>, submit: boolean): string {
  return `You are the Lathe analyst running as a non-interactive ACP consumer.

Use the Lathe MCP server. ${submit ? 'Submit findings by calling mcp__lathe__submit_finding.' : 'Dry-run mode: do not call submit_finding.'}

Finding contract:
- analyst must be "${analyst}".
- kind must be one of: failure_loop, unattributed_diff, excess_cost, risky_action.
- evidence must point to a provided session_id, preferably a turn with locator {"seq": number}.
- include analysis with keys cause_hypothesis, agent_intent, impact.
- cause_hypothesis must name a concrete mechanism visible in transcript evidence, not just restate the finding kind.
- agent_intent must cite the user request or task being pursued.
- impact must explain why that mechanism matters for reviewing this run.
- For EADDRINUSE, occupied ports, tmux/dev-server state, data-dependent flakes, or external runtimes, explicitly distinguish environment/runtime/setup state from product/harness behavior and say whether a code/harness fix is implicated.
- Describe observable behavior only. Do not instruct anyone to edit CLAUDE.md, AGENTS.md, hooks, or harness files.
- Submit 1 to 5 high-signal findings. Avoid generic wording such as "needs further investigation" or "same failing evidence."`;
}

function mcpSubmitExample(analyst: AnalystCandidate): string {
  return `submit_finding argument shape:
{
  "finding": {
    "analyst": "${analyst}",
    "kind": "failure_loop",
    "title": "Short phenomenon title",
    "body": "Observable behavior and evidence summary.",
    "confidence": 0.82,
    "project_id": "optional when evidence can infer it",
    "harness_version_id": null,
    "analysis": {
      "cause_hypothesis": "Concrete mechanism from the evidence.",
      "agent_intent": "User/task intent from the transcript.",
      "impact": "Why the mechanism matters, including env/runtime/setup vs product/harness boundary when relevant."
    },
    "evidence": [
      { "subject_kind": "turn", "session_id": "session id", "locator": { "seq": 3 }, "note": "why this turn is primary" }
    ]
  }
}`;
}

async function querySubmittedCandidateFindings(
  analyst: AnalystCandidate,
  sessionIds: string[],
): Promise<SubmittedFindingRow[]> {
  if (!sessionIds.length) return [];
  return queryRows<SubmittedFindingRow>(
    `SELECT DISTINCT ON (f.id)
            f.id,
            f.kind,
            f.title,
            COALESCE(fe.session_id, CASE WHEN fe.subject_kind = 'session' THEN fe.subject_id END) AS session_id
       FROM findings f
       JOIN finding_evidence fe ON fe.finding_id = f.id
      WHERE f.analyst = $1
        AND (fe.session_id = ANY($2::text[]) OR fe.subject_id = ANY($2::text[]))
      ORDER BY f.id ASC, fe.id ASC`,
    [analyst, sessionIds],
  );
}

function submittedRowsToResult(
  options: RunAnalystOptions,
  beforeIds: Set<number>,
  after: SubmittedFindingRow[],
  logs: string[],
): RunAnalystResult {
  const selected = after.filter((row) => !beforeIds.has(row.id));
  return {
    candidate: options.candidate,
    generated: selected.length,
    submitted: options.submit === false ? 0 : selected.length,
    created: selected.length,
    skipped: false,
    findings: selected.map((row) => ({
      findingId: row.id,
      created: true,
      kind: row.kind,
      title: row.title,
      primarySessionId: row.session_id ?? undefined,
    })),
    logs,
  };
}

function selectHybridRuleContexts(rules: AnalystFindingDraft[]): AnalystFindingDraft[] {
  const priority = [
    'cost_anomaly_baseline',
    'data_dependent_flake_cue',
    'port_collision_cue',
    'self_sufficient_fixture_cue',
    'bisection_accident_cue',
    'repeated_failed_command',
    'unattributed_hunk_ratio',
    'risky_command_pattern',
  ];
  const selected: AnalystFindingDraft[] = [];
  for (const detector of priority) {
    const match = rules.find((rule) => rule.detector === detector && !selected.includes(rule));
    if (match) selected.push(match);
  }
  for (const rule of rules) {
    if (selected.length >= 5) break;
    if (!selected.includes(rule)) selected.push(rule);
  }
  return selected;
}

function findingToMcpPayload(finding: AnalystFindingDraft): Record<string, unknown> {
  return {
    analyst: finding.analyst,
    kind: finding.kind,
    title: finding.title,
    body: finding.body,
    confidence: finding.confidence,
    project_id: finding.projectId,
    harness_version_id: finding.harnessVersionId,
    analysis: finding.analysis
      ? {
          cause_hypothesis: finding.analysis.causeHypothesis ?? null,
          agent_intent: finding.analysis.agentIntent ?? null,
          impact: finding.analysis.impact ?? null,
        }
      : undefined,
    evidence: finding.evidence.map((item) => ({
      subject_kind: item.subjectKind,
      subject_id: item.subjectId,
      session_id: item.sessionId,
      locator: item.locator ?? {},
      note: item.note,
    })),
  };
}
