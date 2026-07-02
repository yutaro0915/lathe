// Prompt templates for scripts/inner-loop.mjs stages.
// Split out from inner-loop.mjs for readability (ADR 0013 permits this split;
// scripts/ is outside the file-size rubric scope but long prompt strings hurt
// readability of the state machine itself).
//
// Each builder returns the full prompt string for `claude -p "<prompt>" --agent <name>`.
// Every prompt ends with the VERDICT instruction (ADR 0013 §機構詳細 verdict 規約):
// the agent must emit `VERDICT: <TOKEN>` as the last line, which the driver parses
// from the envelope's `result` field.

/**
 * Common issue/stage marker line, per ADR 0013 §2: "段 prompt に issue #<n> / stage: <STAGE>
 * マーカーを入れる（title に乗る保険）".
 * @param {number} issueNumber
 * @param {string} stage
 * @returns {string}
 */
function marker(issueNumber, stage) {
  return `issue #${issueNumber} / stage: ${stage}`;
}

/**
 * @param {string[]} tokens  valid VERDICT tokens for this stage, e.g. ['PLAN_READY', 'ESCALATE']
 * @returns {string}
 */
function verdictInstruction(tokens) {
  return `最終行に必ず次の形式で verdict を出力してください（他の形式は不可）:\nVERDICT: <TOKEN>\n<TOKEN> は次のいずれか: ${tokens.join(' | ')}`;
}

/**
 * PLAN stage prompt — planner agent, cwd = repo root.
 * @param {{ issueNumber: number, issueTitle: string, issueBody: string }} ctx
 * @returns {string}
 */
export function buildPlanPrompt(ctx) {
  const { issueNumber, issueTitle, issueBody } = ctx;
  return [
    marker(issueNumber, 'PLAN'),
    '',
    `以下の issue を実装するための scoped implementation plan を作成してください。`,
    '',
    `## issue #${issueNumber}: ${issueTitle}`,
    issueBody ?? '',
    '',
    '受け入れ基準・対象ファイル・検証方法（gate/tier）を明示してください。',
    '',
    'rigor は影響クラスでスケールします。**低リスク小変更は軽量 plan で可**（受け入れ基準・検証方法・scope 境界だけ falsifiable に示す）。',
    '',
    verdictInstruction(['PLAN_READY', 'ESCALATE']),
  ].join('\n');
}

/**
 * IMPLEMENT stage prompt — implementer agent, cwd = worktree.
 * @param {{ issueNumber: number, issueTitle: string, issueBody: string, plan: string, feedback?: string }} ctx
 * @returns {string}
 */
export function buildImplementPrompt(ctx) {
  const { issueNumber, issueTitle, issueBody, plan, feedback } = ctx;
  const lines = [
    marker(issueNumber, 'IMPLEMENT'),
    '',
    `以下の plan に従って issue #${issueNumber}: ${issueTitle} を実装してください。`,
    '',
    `あなたは implementer です。既に worktree \`inner-issue-${issueNumber}\`（branch \`inner/issue-${issueNumber}\`）の**中**に居ます。その場で編集してください。**ネストした subagent を spawn しない・main（repo root）に書かない・別 worktree を切らない**。`,
    '',
    '## issue',
    issueBody ?? '',
    '',
    '## plan',
    plan ?? '',
  ];
  if (feedback) {
    lines.push('', '## 差し戻し指摘（前段からの feedback。対処すること）', feedback);
  }
  lines.push(
    '',
    '1 commit にまとめること（差し戻しの場合は amend）。明示 `git add <paths>` を使うこと（`git add -A` / `git add .` は禁止）。',
    '実 exit code を確認して検証すること（推測で GREEN と書かない）。',
    '',
    verdictInstruction(['IMPL_DONE', 'ESCALATE']),
  );
  return lines.join('\n');
}

/**
 * REVIEW stage prompt — reviewer agent, cwd = worktree.
 * Note: receipt issuance is NOT part of this prompt — the driver stamps the
 * REVIEW receipt itself from the parsed verdict (see inner-loop.mjs
 * buildReceiptArgs), because an agent-issued `LATHE_AGENT=... node
 * scripts/receipt.mjs ...` command silently fails the Bash allowlist
 * (env-prefixed commands don't prefix-match `Bash(node scripts/receipt.mjs *)`).
 * @param {{ issueNumber: number, plan: string, headSha: string }} ctx
 * @returns {string}
 */
export function buildReviewPrompt(ctx) {
  const { issueNumber, plan } = ctx;
  return [
    marker(issueNumber, 'REVIEW'),
    '',
    '`.claude/skills/review/SKILL.md` の手順に従い、未コミットではなく main からの branch diff（現在の HEAD）を plan ＋ 該当 rubric に照らしてレビューしてください。',
    'diff は **inline の `git diff main...HEAD`** で取得すること。単純な diff 収集を subagent に委譲しない。',
    '',
    '**receipt（受領証）は driver が刻みます。あなたは発行しないでください**。最終行に `VERDICT: <TOKEN>` のみを出力すること。',
    '',
    '## plan',
    plan ?? '',
    '',
    verdictInstruction(['PASS', 'CHANGES', 'ESCALATE']),
  ].join('\n');
}

/**
 * VERIFY stage prompt — verifier agent, cwd = worktree.
 * Note: receipt issuance is NOT part of this prompt — the driver stamps the
 * VERIFY receipt itself from the parsed verdict (see inner-loop.mjs
 * buildReceiptArgs); see buildReviewPrompt's note for why.
 * @param {{ issueNumber: number, headSha: string }} ctx
 * @returns {string}
 */
export function buildVerifyPrompt(ctx) {
  const { issueNumber } = ctx;
  return [
    marker(issueNumber, 'VERIFY'),
    '',
    '`.claude/skills/verify/SKILL.md` の手順に厳密に従い、変更の影響範囲に該当する gate/test を独立実行してください。',
    '実 exit code で判定すること（推測で GREEN と書かない）。',
    '',
    '**receipt（受領証）は driver が刻みます。あなたは発行しないでください**。最終行に `VERDICT: <TOKEN>` のみを出力すること。',
    '',
    verdictInstruction(['GREEN', 'RED', 'ESCALATE']),
  ].join('\n');
}

/**
 * TRIAGE stage prompt — test-triage agent, cwd = worktree, read-only.
 * @param {{ issueNumber: number, verifyResult: string }} ctx
 * @returns {string}
 */
export function buildTriagePrompt(ctx) {
  const { issueNumber, verifyResult } = ctx;
  return [
    marker(issueNumber, 'TRIAGE'),
    '',
    '`.claude/skills/test-triage/SKILL.md` の手順に従い、以下の verifier の RED を既知/新規に分類してください。',
    '',
    '## verifier の RED 結果',
    verifyResult ?? '',
    '',
    '既知（KNOWN）の場合は playbook の対処を明示してください（IMPLEMENT 段に差し戻します）。',
    '新規（NOVEL）の場合は evidence と仮説を添えてください（エスカレーションします）。',
    '',
    verdictInstruction(['KNOWN', 'NOVEL', 'ESCALATE']),
  ].join('\n');
}

export const STAGE_PROMPT_BUILDERS = {
  PLAN: buildPlanPrompt,
  IMPLEMENT: buildImplementPrompt,
  REVIEW: buildReviewPrompt,
  VERIFY: buildVerifyPrompt,
  TRIAGE: buildTriagePrompt,
};

/**
 * Dispatch to the right prompt builder for a stage.
 * @param {string} stage
 * @param {object} ctx
 * @returns {string}
 */
export function buildStagePrompt(stage, ctx) {
  const builder = STAGE_PROMPT_BUILDERS[stage];
  if (!builder) {
    throw new Error(`buildStagePrompt: unknown stage "${stage}"`);
  }
  return builder(ctx);
}
