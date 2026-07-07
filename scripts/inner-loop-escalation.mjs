// inner-loop-escalation.mjs — escalation の issue 化（#201 分解 6, #117 ADR 0035 §4）。
// ESCALATE 終端は対象 issue への投影に一本化する:
//   escalation label（無ければ gh label create で新設）＋レポート全文の comment。
// ローカル .lathe/runs/*.escalation.md は廃止（状態は gh から導出 = ADR 0031。
// 旧 provisional surface は #116 監査役裁定 3）。escalation label 付き issue は
// queue が skip する（SKIP_ESCALATION, ADR 0030 追記 E）— PdM 裁定 comment →
// label 除去で再開。driver（task loop）と plan-task の両経路がここを通る
// 単一の出口。meta-loop の escalation は別 loop・別監視（run-health.json）で
// scope 外。投影失敗は非致命（warn して続行）— run を止めるかは呼び出し側の管轄。
//
// triage 分類は inner-loop-escalation-triage.mjs の classifyEscalation が担う
// （ADR 0035 §4）。escalateIssue（inner-loop.mjs）が分類を受けて分岐する。

import { spawnSync } from 'node:child_process';
import { REPO_ROOT, ESCALATION_LABEL } from './inner-loop-core.mjs';

function clippedExcerpt(text, maxChars = 4000) {
  const value = String(text ?? '').trim();
  if (value.length <= maxChars) return value;
  return `...${value.slice(-maxChars)}`;
}

/**
 * Render the escalation report (the full text posted as the issue comment).
 * @param {{ issueNumber: number, stage: string, verdict: string|null, ts?: string, resultExcerpt?: string|null, runType?: 'task' | 'plan-task' }} p
 * @returns {string}
 */
export function buildEscalationMarkdown({ issueNumber, stage, verdict, ts, resultExcerpt, runType }) {
  const subject = runType === 'plan-task' ? `plan-task issue #${issueNumber}` : `issue #${issueNumber}`;
  return [
    `# escalation — ${subject}`,
    '',
    `stage: ${stage}`,
    `verdict: ${verdict ?? '(none/unparsable)'}`,
    `ts: ${ts ?? new Date().toISOString()}`,
    '',
    '## result excerpt',
    '',
    '```',
    clippedExcerpt(resultExcerpt, 4000),
    '```',
    '',
  ].join('\n');
}

/**
 * Project an escalation onto its issue: add the `escalation` label (creating
 * the label on first use) and post the full report as a comment. Non-fatal —
 * every failure is a warning; the caller decides whether the run dies.
 * @param {{ issueNumber: number, stage: string, verdict: string|null, resultExcerpt?: string|null, runType?: 'task' | 'plan-task' }} p
 * @param {{ spawnSync?: Function, cwd?: string, log?: (msg:string)=>void }} deps
 * @returns {{ ok: boolean, labelOk: boolean, commentOk: boolean }}
 */
export function projectEscalation({ issueNumber, stage, verdict, resultExcerpt, runType }, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const logFn = deps.log ?? (() => {});
  const cwd = deps.cwd ?? REPO_ROOT;
  const report = buildEscalationMarkdown({ issueNumber, stage, verdict, resultExcerpt, runType });

  const addLabel = () => run('gh', ['issue', 'edit', String(issueNumber), '--add-label', ESCALATION_LABEL],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).status === 0;

  let labelOk = addLabel();
  if (!labelOk) {
    // First use on a repo without the label: create it, then retry once.
    run('gh', ['label', 'create', ESCALATION_LABEL,
      '--description', 'inner-loop escalation — PdM 裁定待ち（裁定 comment → label 除去で再開, ADR 0030 追記 E）',
      '--color', 'B60205'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    labelOk = addLabel();
  }
  if (!labelOk) logFn(`warning: could not add ${ESCALATION_LABEL} label to issue #${issueNumber} (continuing)`);

  const cr = run('gh', ['issue', 'comment', String(issueNumber), '--body-file', '-'],
    { cwd, encoding: 'utf8', input: report, stdio: ['pipe', 'pipe', 'pipe'] });
  const commentOk = cr.status === 0;
  if (!commentOk) logFn(`warning: could not post escalation report comment on issue #${issueNumber} (continuing)`);

  return { ok: labelOk && commentOk, labelOk, commentOk };
}
