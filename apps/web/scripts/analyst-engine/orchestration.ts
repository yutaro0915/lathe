import { submitFinding } from '../../lib/mcp';
import { runHybridCandidate, runLlmCandidate } from './acp';
import { enrichDraftsWithAnalysis } from './analysis';
import {
  clampLimit,
  findingKey,
  primarySessionId,
  type AnalystFindingDraft,
  type RunAnalystOptions,
  type RunAnalystResult,
  type TurnScope,
} from './common';
import { runRulesCandidate } from './rules';

export async function runAnalyst(options: RunAnalystOptions): Promise<RunAnalystResult> {
  if (options.candidate === 'rules-v1') {
    return submitDrafts(await runRulesCandidate('rules-v1', options), options);
  }
  if (options.candidate === 'llm-v1') {
    return runLlmCandidate(options);
  }
  return runHybridCandidate(options);
}

export function scheduleRulesAnalystAfterNotify(sessionId: string): void {
  if (process.env.LATHE_ANALYST_NOTIFY === '0') return;
  const delay = Math.max(0, Number(process.env.LATHE_ANALYST_NOTIFY_DELAY_MS || 0));
  setTimeout(() => {
    void runAnalyst({ candidate: 'rules-v1', sessionId, source: 'notify' }).catch((error) => {
      console.error(`[analyst:notify] rules-v1 failed for ${sessionId}: ${(error as Error).message}`);
    });
  }, delay);
}

export function parseTurnSpec(value: string): TurnScope {
  const index = value.lastIndexOf(':');
  if (index <= 0) throw new Error('--turn must be <session>:<n>');
  const sessionId = value.slice(0, index);
  const seq = Number(value.slice(index + 1));
  if (!sessionId || !Number.isInteger(seq) || seq <= 0) throw new Error('--turn must be <session>:<positive integer>');
  return { sessionId, seq };
}

async function submitDrafts(drafts: AnalystFindingDraft[], options: RunAnalystOptions): Promise<RunAnalystResult> {
  const logs: string[] = [];
  const selected = await selectDrafts(drafts, options.limit);
  const findings: RunAnalystResult['findings'] = [];
  let submitted = 0;
  let created = 0;
  if (options.submit !== false) {
    for (const draft of selected) {
      const result = await submitFinding(draft);
      submitted++;
      if (result.created) created++;
      findings.push({
        findingId: result.findingId,
        created: result.created,
        kind: draft.kind,
        title: draft.title,
        primarySessionId: primarySessionId(draft),
      });
    }
  } else {
    for (const draft of selected) findings.push({ kind: draft.kind, title: draft.title, primarySessionId: primarySessionId(draft) });
  }
  logs.push(`candidate=${options.candidate} generated=${drafts.length} selected=${selected.length} submitted=${submitted} created=${created}`);
  return { candidate: options.candidate, generated: drafts.length, submitted, created, skipped: false, findings, logs };
}

async function selectDrafts(drafts: AnalystFindingDraft[], limitValue: number | undefined): Promise<AnalystFindingDraft[]> {
  const limit = clampLimit(limitValue);
  const unique = new Map<string, AnalystFindingDraft>();
  for (const draft of await enrichDraftsWithAnalysis(drafts)) {
    const key = findingKey(draft);
    const prior = unique.get(key);
    if (!prior || draft.confidence > prior.confidence) unique.set(key, draft);
  }
  return [...unique.values()].sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}
