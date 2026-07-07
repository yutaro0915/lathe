// orchestrator-classify.mjs — 導出状態（orchestrator-derive の snapshot）→ 仕事割当の
// 決定的純関数（#201 分解 8）。side effect なし。分類規則の正本は issue #201
// 「分類規則（始点→プロセス→終端）」。
//
// dispatch クラス:
//   PLAN       — plan 未確定（needs-plan label、ADR 0030 追記 A の機械的事実）。
//                driver が run type を label から選ぶため dispatch コマンドは実装と
//                同じ `node scripts/inner-loop.mjs <n>`（plan-task になる）
//   EXPLAIN    — needs-review × 教材なし（done-explain label なし・explains/ 正本なし）
//                → explain runner。教材の証拠は label または explains/ の対象 slug 正本
//                の 2 層（#201 分解 13: label 付与失敗の窓でも再生成しない）
//   IMPLEMENT  — 無印（plan review PASS は driver の TASK_PLAN→PLAN_REVIEW→IMPLEMENT
//                が run 内で強制、ADR 0035 §1）／needs-review は盤面 Status=Ready 検出後
//   PR_REVIEW  — 非 driver 産 open PR × review 記録なし → review engine
// 待機系（dispatch しない）:
//   WAIT_ESCALATION — escalation label（裁定 loop 材料。故障と数えない、ADR 0030 追記 E）
//   WAIT_RUNNING    — live マーカー等で実行中（worktree 非依存の判定は shell 側）
//   WAIT_PR         — open PR が issue を参照（In Progress、ADR 0031 §2 導出）
//   WAIT_DEP        — blocked-by 参照が open
//   WAIT_APPROVAL   — needs-review × 教材あり × 非 Ready（PdM の読む番）
// skip（対象外）:
//   SKIP_NON_TASK / SKIP_DRAFT / SKIP_DRIVER_PR / SKIP_REVIEWED

import {
  TASK_REQUEST_LABEL, NEEDS_PLAN_LABEL, NEEDS_REVIEW_LABEL,
} from './inner-loop-core.mjs';
import { ESCALATION_LABEL, deriveInProgressIssueNumbers } from './inner-queue-decisions.mjs';

// --- Constants ---

export const CLASS_PLAN = 'PLAN';
export const CLASS_EXPLAIN = 'EXPLAIN';
export const CLASS_IMPLEMENT = 'IMPLEMENT';
export const CLASS_PR_REVIEW = 'PR_REVIEW';

export const WAIT_ESCALATION = 'WAIT_ESCALATION';
export const WAIT_RUNNING = 'WAIT_RUNNING';
export const WAIT_PR = 'WAIT_PR';
export const WAIT_DEP = 'WAIT_DEP';
export const WAIT_APPROVAL = 'WAIT_APPROVAL';

export const SKIP_NON_TASK = 'SKIP_NON_TASK';
export const SKIP_DRAFT = 'SKIP_DRAFT';
export const SKIP_DRIVER_PR = 'SKIP_DRIVER_PR';
export const SKIP_REVIEWED = 'SKIP_REVIEWED';

// 教材（解説 loop の label 状態機械の終端、skills/explain-diff）
export const DONE_EXPLAIN_LABEL = 'done-explain';

// 盤面 Status の列名（id は使わない — id は derive が名前解決する）
export const STATUS_BACKLOG = 'Backlog';
export const STATUS_APPROVAL = 'Approval';
export const STATUS_READY = 'Ready';
export const STATUS_ESCALATED = 'Escalated';

const DISPATCH_CLASSES = new Set([CLASS_PLAN, CLASS_EXPLAIN, CLASS_IMPLEMENT, CLASS_PR_REVIEW]);

// --- Pure helpers ---

function hasLabel(labels, name) {
  const wanted = String(name).toLowerCase();
  return (labels ?? []).some((label) => String(label).toLowerCase() === wanted);
}

/** @param {string} cls @returns {boolean} */
export function isDispatchClass(cls) {
  return DISPATCH_CLASSES.has(cls);
}

/**
 * 1 issue の分類。判定順: task-request → escalation → 実行中 → open PR 参照 →
 * blocked-by → needs-plan → needs-review（Ready / 教材 / 承認待ち）→ 無印実装。
 * @param {{ number: number, labels: string[], blockedBy: number[], statusName: string|null }} issue
 * @param {{ openIssueNumbers: Set<number>, inProgressIssueNumbers: Set<number>,
 *           runningIssueNumbers: Set<number>, explainedIssueNumbers?: Set<number> }} ctx
 * @returns {{ class: string, reason: string, unresolved?: number[] }}
 */
export function classifyIssue(issue, ctx) {
  if (!hasLabel(issue.labels, TASK_REQUEST_LABEL)) {
    return { class: SKIP_NON_TASK, reason: 'task-request label なし — orchestrator の対象外' };
  }
  if (hasLabel(issue.labels, ESCALATION_LABEL)) {
    return { class: WAIT_ESCALATION, reason: 'escalation label — PdM 裁定待ち（裁定 loop 材料）' };
  }
  if (ctx.runningIssueNumbers?.has(issue.number)) {
    return { class: WAIT_RUNNING, reason: 'live マーカー/worktree が実行中を示す' };
  }
  if (ctx.inProgressIssueNumbers?.has(issue.number)) {
    return { class: WAIT_PR, reason: 'open PR が参照 = In Progress（ADR 0031 §2）' };
  }
  const unresolved = (issue.blockedBy ?? []).filter((ref) => ctx.openIssueNumbers?.has(ref));
  if (unresolved.length > 0) {
    return { class: WAIT_DEP, reason: `blocked-by ${unresolved.map((n) => `#${n}`).join(', ')} が open`, unresolved };
  }
  if (hasLabel(issue.labels, NEEDS_PLAN_LABEL)) {
    return { class: CLASS_PLAN, reason: 'plan 未確定（needs-plan）— driver が plan-task を実行' };
  }
  if (hasLabel(issue.labels, NEEDS_REVIEW_LABEL)) {
    if (issue.statusName === STATUS_READY) {
      return { class: CLASS_IMPLEMENT, reason: 'needs-review × 盤面 Ready — 承認済み' };
    }
    // 教材の証拠は 2 層: done-explain label（第 1）または explains/ の対象 slug 正本
    // （第 2、#201 分解 13 — label 付与失敗の窓での重複生成を防ぐ）。
    const hasLabelEvidence = hasLabel(issue.labels, DONE_EXPLAIN_LABEL);
    const hasFileEvidence = ctx.explainedIssueNumbers?.has(issue.number) === true;
    if (!hasLabelEvidence && !hasFileEvidence) {
      return { class: CLASS_EXPLAIN, reason: 'needs-review × 教材なし — PdM が読む教材を先に作る' };
    }
    return {
      class: WAIT_APPROVAL,
      reason: `needs-review × 教材あり（${hasLabelEvidence ? 'done-explain' : 'explains/ 正本'}）× 非 Ready — PdM の読む番`,
    };
  }
  return { class: CLASS_IMPLEMENT, reason: '無印 — plan review PASS は driver の run 内で強制（ADR 0035 §1）' };
}

/**
 * 1 PR の分類（class④: 非 driver 産 open PR × review 記録なし → PR review）。
 * driver 産 PR（inner/issue-<n>）は task loop の landing 経路 — review engine の
 * 全 PR パス（cron）に委ね、orchestrator からは重ねて dispatch しない。
 * @param {{ number: number, isDraft: boolean, isDriverPr: boolean, hasReviewRecord: boolean }} pr
 * @param {{ runningPrNumbers?: Set<number> }} ctx
 * @returns {{ class: string, reason: string }}
 */
export function classifyPr(pr, ctx = {}) {
  if (ctx.runningPrNumbers?.has(pr.number)) {
    return { class: WAIT_RUNNING, reason: 'live マーカーが review 実行中を示す' };
  }
  if (pr.isDraft) {
    return { class: SKIP_DRAFT, reason: 'draft — 作者の「review 未準備」signal' };
  }
  if (pr.isDriverPr) {
    return { class: SKIP_DRIVER_PR, reason: 'driver 産（inner/issue-<n>）— task loop の landing 経路' };
  }
  if (pr.hasReviewRecord) {
    return { class: SKIP_REVIEWED, reason: 'review 記録あり（## REVIEW: / engine marker）' };
  }
  return { class: CLASS_PR_REVIEW, reason: '非 driver 産 × review 記録なし' };
}

/**
 * snapshot 全体 → 決定リスト（issue 昇順 → PR 昇順の決定的順序）。
 * 各決定は分類の根拠オブジェクト（issue / pr）を保持する（dispatch shell が
 * Touches 直列化や投影に使う）。
 * @param {{ issues?: object[], prs?: object[], openBlockerRefs?: number[] }} snapshot  orchestrator-derive の OrchestratorSnapshot
 * @param {{ issues?: Set<number>, prs?: Set<number> }} running  実行中 target（worktree 非依存判定は shell 側）
 * @param {{ explainedIssueNumbers?: Set<number> }} extras  explains/ 由来の教材 evidence
 *   （shell 側が explains/ の実在ファイルから導出、orchestrator-explain.mjs）
 * @returns {Array<{ kind: 'issue'|'pr', number: number, class: string, reason: string,
 *   unresolved?: number[], issue?: object, pr?: object }>}
 */
export function classifyAll(snapshot, running = {}, extras = {}) {
  const openIssueNumbers = new Set([
    ...(snapshot.issues ?? []).map((i) => i.number),
    ...(snapshot.openBlockerRefs ?? []),
  ]);
  const ctx = {
    openIssueNumbers,
    inProgressIssueNumbers: deriveInProgressIssueNumbers(snapshot.prs ?? []),
    runningIssueNumbers: running.issues ?? new Set(),
    explainedIssueNumbers: extras.explainedIssueNumbers ?? new Set(),
  };
  const decisions = [];
  for (const issue of [...(snapshot.issues ?? [])].sort((a, b) => a.number - b.number)) {
    decisions.push({ kind: 'issue', number: issue.number, issue, ...classifyIssue(issue, ctx) });
  }
  for (const pr of [...(snapshot.prs ?? [])].sort((a, b) => a.number - b.number)) {
    decisions.push({ kind: 'pr', number: pr.number, pr, ...classifyPr(pr, { runningPrNumbers: running.prs ?? new Set() }) });
  }
  return decisions;
}

/**
 * 決定 1 件の 1 行表示（分類表・dry-run 出力用）。
 * @param {{ kind: string, number: number, class: string, reason?: string }} decision
 * @returns {string}
 */
export function formatDecision(decision) {
  const target = decision.kind === 'pr' ? `PR #${decision.number}` : `#${decision.number}`;
  return `${decision.class} ${target}${decision.reason ? ` — ${decision.reason}` : ''}`;
}

// --- 盤面投影の計画（#201 分解 10 — 適用は orchestrator.mjs、ここは純関数） ---

/**
 * パス末尾の盤面同期の計画。実状態（分類結果）→ Status 列の写像:
 *   WAIT_ESCALATION（escalation label）            → Escalated 列
 *   WAIT_APPROVAL（needs-review×教材あり×非 Ready）→ Approval 列
 * 列へ「入れる」投影のみ行い、Escalated からの掃き出しはしない — 旧
 * .escalation.md 経路の escalation（label 未付与、#203 で label へ移行）が
 * 盤面 Escalated に残っている移行窓で、PdM の裁定待ち signal を消さないため。
 * 掃き出しは後続の実状態投影（driver の In progress／本関数の Approval）が行う。
 * option id は使う直前に名前→id で引く（derive が名前解決した statusField。
 * id 直書きはしない）。盤面に無い issue・無い列は warning にして skip（非致命）。
 * @param {Array<{ kind: string, number: number, class: string, issue?: object }>} decisions
 * @param {{ fieldId: string, options: Object<string, string> } | null} statusField
 * @returns {{ mutations: Array<{ number: number, itemId: string, fromName: string|null,
 *   toName: string, optionId: string }>, warnings: string[] }}
 */
export function planBoardProjection(decisions, statusField) {
  const warnings = [];
  const mutations = [];
  if (!statusField) {
    return { mutations, warnings: ['Status field 未解決 — 盤面投影を skip（非致命）'] };
  }
  for (const decision of decisions ?? []) {
    if (decision.kind !== 'issue' || !decision.issue || decision.class === SKIP_NON_TASK) continue;
    let toName = null;
    if (decision.class === WAIT_ESCALATION) toName = STATUS_ESCALATED;
    else if (decision.class === WAIT_APPROVAL) toName = STATUS_APPROVAL;
    if (!toName || decision.issue.statusName === toName) continue;
    if (!decision.issue.projectItemId) {
      warnings.push(`#${decision.number}: 盤面に載っていない — ${toName} 投影を skip`);
      continue;
    }
    const optionId = statusField.options?.[toName];
    if (!optionId) {
      warnings.push(`#${decision.number}: 盤面に option "${toName}" が無い — 投影を skip`);
      continue;
    }
    mutations.push({
      number: decision.number,
      itemId: decision.issue.projectItemId,
      fromName: decision.issue.statusName ?? null,
      toName,
      optionId,
    });
  }
  return { mutations, warnings };
}
