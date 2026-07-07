// inner-loop-plan-validate.mjs — plan-task PLAN 出力の書式検証（#201 Wave4）。
//
// 子 issue の投函（FILE_CHILDREN）は planner の出力書式に厳格依存し、書式逸脱
// （欠落 Title・前方参照 plan#k 等、2026-07-07 実測 2 件）が修正周回に乗らず
// escalate 即死していた。ここは FILE_CHILDREN の前に置く純関数の検証層:
// fail-fast でなく全指摘を集めて返し、driver が所見リストを
// buildReviewFeedbackSection 経由で PLAN に差し戻せるようにする。
// 黙った推測補正はしない — 検証・差し戻し・escalation の 3 段のみ。
//
// Pure module: no side effects, no gh. Split out of inner-loop-plan-task.mjs
// (which re-exports the parse API for existing importers) to keep both files
// under the 500-line file-size rubric.

// FILE_CHILDREN 書式検証 NG → PLAN 差し戻しの修正周回上限。planner の書式逸脱
// を escalate 即死させず、所見を注入した informed retry を 1 周だけ許す。
// 再 NG は escalation（分岐は decidePlanValidationAction）。
export const MAX_PLAN_CHILDREN_VALIDATION_RETRIES = 1;

/**
 * Drop standalone `VERDICT: <TOKEN>` lines (driver 制御行は子 issue 本文や
 * comment に残さない).
 * @param {string} text
 * @returns {string}
 */
export function stripVerdictLine(text) {
  return String(text ?? '').split(/\r?\n/).filter((line) => !/^VERDICT:\s*[A-Z_]+\s*$/.test(line)).join('\n').trim();
}

function firstMatchingLine(text, pattern) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Validate a plan-task child block's `Blocked-by:` value. A missing or empty
 * line is a parser failure, not "no deps" — silently rounding "absent" down
 * to "no deps" would file child issues with unverified dependency claims.
 * Blocks with no real dependency must say so explicitly with `none`.
 * @param {string | null} rawValue - the captured value after "Blocked-by:",
 *   or null if the line itself was not found in the block.
 * @returns {{ ok: true, blockedBy: string } | { ok: false, error: string }}
 */
export function parseBlockedByLine(rawValue) {
  if (rawValue == null) {
    return { ok: false, error: 'plan block is missing required "Blocked-by:" line (use "Blocked-by: none" if there are no dependencies)' };
  }
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'plan block has an empty "Blocked-by:" value (use "Blocked-by: none" if there are no dependencies)' };
  }
  if (/^none$/i.test(trimmed)) {
    return { ok: true, blockedBy: '' };
  }
  return { ok: true, blockedBy: trimmed };
}

function parseRejectedCandidateLine(line) {
  const match = String(line ?? '').match(/^\s*(?:[-*]\s*)?Rejected\s*:\s*(.+?)\s+(?:—|-)\s+(.+?)\s*$/i);
  if (!match) return null;
  return { candidate: match[1].trim(), reason: match[2].trim() };
}

// Split the PLAN result into raw child blocks (each starting at a `Title:`
// line) and `Rejected:` candidate records. Shared by validate and parse.
function splitPlanChildBlocks(planText) {
  const rejected = [];
  const blocks = [];
  let currentBlock = null;

  for (const line of String(planText ?? '').split(/\r?\n/)) {
    if (/^VERDICT:\s*[A-Z_]+\s*$/.test(line.trim())) continue;

    const rejectedCandidate = parseRejectedCandidateLine(line);
    if (rejectedCandidate) {
      rejected.push(rejectedCandidate);
      continue;
    }

    if (/^\s*Title\s*:\s*.+$/i.test(line)) {
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = [line];
      continue;
    }

    if (currentBlock) currentBlock.push(line);
  }

  if (currentBlock) blocks.push(currentBlock);
  return { blocks, rejected };
}

// plan#<k> reference semantics: refs must point to existing blocks (欠番 NG),
// strictly earlier ones (前方参照・自己参照 NG — creation is sequential, so the
// contract is topological order / backward references only), without
// duplicates. Same token grammar as resolvePlanChildDependency.
function validatePlanLocalRefs(blockedBy, index, totalBlocks) {
  const findings = [];
  const seen = new Set();
  for (const match of String(blockedBy ?? '').matchAll(/\bplan#(\d+)\b/gi)) {
    const k = Number(match[1]);
    if (seen.has(k)) {
      findings.push(`plan block ${index}: duplicate reference "plan#${k}" in "Blocked-by:"`);
      continue;
    }
    seen.add(k);
    if (k < 1 || k > totalBlocks) {
      findings.push(`plan block ${index}: "plan#${k}" references a non-existent plan block (this plan has plan#1..plan#${totalBlocks})`);
    } else if (k === index) {
      findings.push(`plan block ${index}: "plan#${k}" is a self reference — a block cannot depend on itself`);
    } else if (k > index) {
      findings.push(`plan block ${index}: "plan#${k}" is a forward reference — order blocks topologically so "Blocked-by:" only points to earlier blocks (plan#1..plan#${index - 1})`);
    }
  }
  return findings;
}

/**
 * Validate the plan-task PLAN output before FILE_CHILDREN. Pure: collects ALL
 * format findings（欠落 Title・欠落/空 Blocked-by・欠落 Touches・plan#k の
 * 前方/自己参照・欠番・重複）instead of failing fast, so the driver can bounce
 * the whole 指摘リスト back to the planner in one corrective round.
 * @param {string} planText
 * @returns {{ ok: true, findings: [], children: Array<{ index: number, title: string, blockedBy: string, touches: string, plan: string }>, rejected: Array<{candidate: string, reason: string}> }
 *         | { ok: false, findings: string[] }}
 */
export function validatePlanChildBlocks(planText) {
  const { blocks, rejected } = splitPlanChildBlocks(planText);
  if (blocks.length === 0) {
    return { ok: false, findings: ['plan is missing required "Title:" line — no child issue block found (each block must start with "Title: <child issue title>")'] };
  }

  const findings = [];
  const children = [];
  for (const [zeroBasedIndex, lines] of blocks.entries()) {
    const index = zeroBasedIndex + 1;
    const blockText = lines.join('\n').trim();
    const blockFindings = [];

    const title = firstMatchingLine(blockText, /^\s*Title\s*:\s*(.+)$/i);
    if (!title) {
      blockFindings.push(`plan block ${index} is missing required "Title:" line`);
    }
    const blockedByResult = parseBlockedByLine(firstMatchingLine(blockText, /^\s*Blocked-by\s*:\s*(.*)$/i));
    if (!blockedByResult.ok) {
      blockFindings.push(`plan block ${index}: ${blockedByResult.error}`);
    } else {
      blockFindings.push(...validatePlanLocalRefs(blockedByResult.blockedBy, index, blocks.length));
    }
    const touches = firstMatchingLine(blockText, /^\s*Touches\s*:\s*(.*)$/i);
    if (touches == null) {
      blockFindings.push(`plan block ${index} is missing required "Touches:" line`);
    }

    if (blockFindings.length === 0) {
      children.push({ index, title, blockedBy: blockedByResult.blockedBy, touches, plan: stripVerdictLine(blockText) });
    }
    findings.push(...blockFindings);
  }

  if (findings.length > 0) return { ok: false, findings };
  return { ok: true, findings: [], children, rejected };
}

/**
 * Parse the plan-task PLAN result into child issue blocks. Each block starts
 * with a `Title:` line and must carry `Blocked-by:` and `Touches:` machine
 * lines; `Rejected: <candidate> — <reason>` lines record dropped candidates.
 * Strict single-error facade over validatePlanChildBlocks (defense-in-depth
 * for createChildIssues — validated text always parses).
 * @param {string} planText
 * @returns {{ ok: true, children: Array<{ index: number, title: string, blockedBy: string, touches: string, plan: string }>, rejected: Array<{candidate: string, reason: string}> } | { ok: false, error: string }}
 */
export function parsePlanChildBlocks(planText) {
  const validated = validatePlanChildBlocks(planText);
  if (!validated.ok) return { ok: false, error: validated.findings[0] };
  return { ok: true, children: validated.children, rejected: validated.rejected };
}

/**
 * 指摘リスト → PLAN 差し戻し用の所見テキスト（buildReviewFeedbackSection の
 * findings に渡す）。
 * @param {string[]} findings
 * @returns {string}
 */
export function buildPlanValidationFeedback(findings) {
  return [
    '子 issue 投函（FILE_CHILDREN）前の書式検証で、plan 出力に以下の問題が検出されました。',
    '出力契約（各 block は Title: / Blocked-by: / Touches: の機械可読 3 行で開始・block は依存のトポロジカル順・`plan#<k>` は後方参照のみ）に従って plan 全体を修正し、再出力してください。',
    '',
    ...(findings ?? []).map((finding) => `- ${finding}`),
  ].join('\n');
}

/**
 * 書式検証の分岐・周回判定（decideLandReviewAction と同型の純関数）。
 * ok → file（投函続行）、NG かつ周回残あり → retry（所見を PLAN に差し戻し）、
 * NG かつ上限到達 → escalate。
 * @param {{ validation: { ok: boolean, findings?: string[] }, retriesUsed: number, maxRetries?: number }} p
 * @returns {{ action: 'file' | 'retry' } | { action: 'escalate', reason: string }}
 */
export function decidePlanValidationAction({ validation, retriesUsed, maxRetries = MAX_PLAN_CHILDREN_VALIDATION_RETRIES }) {
  if (validation?.ok) return { action: 'file' };
  if (retriesUsed >= maxRetries) {
    return { action: 'escalate', reason: `plan format validation still failing after ${maxRetries} corrective retry round(s) — 修正周回上限超過` };
  }
  return { action: 'retry' };
}
