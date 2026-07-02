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

const PLAN_LOOP_ESCALATION_CONTRACT = [
  'plan-loop escalation: ユーザー裁可が必要な設計判断、調査結果による目標不成立・前提矛盾、生成 task の依存が既存 open issue と衝突する場合は ESCALATE してください。',
  'PLAN_REVIEW の差し戻し指摘が未定義の契約・ロール割当・規約新設の決定を求めている（問題は述べられているが実装解が一意でない）場合は、CHANGES で planner に押し返さないでください。最小変更を発明せず ESCALATE してください。',
].join(' ');
const IMPL_LOOP_ESCALATION_CONTRACT = [
  'impl-loop escalation: plan の前提が現実（コードの現状・依存状態）と乖離している場合は、その場で再計画せず ESCALATE してください。',
  '差し戻し指摘が未定義の契約・ロール割当・規約新設の決定を求めている（問題は述べられているが実装解が一意でない）場合は、最小変更を発明せず ESCALATE してください。',
  '既存条件（VERDICT 不能・周回超過・NOVEL RED・merge 失敗・main dirty）も ESCALATE です。',
].join(' ');

/**
 * RESEARCH stage prompt — researcher agent, cwd = repo root.
 * @param {{ issueNumber: number, issueTitle: string, issueBody: string }} ctx
 * @returns {string}
 */
export function buildResearchPrompt(ctx) {
  const { issueNumber, issueTitle, issueBody } = ctx;
  return [
    marker(issueNumber, 'RESEARCH'),
    '',
    `以下の needs-plan issue を実装 issue に落とすため、現在のコード・ADR・関連 issue を調査してください。`,
    '',
    `## source issue #${issueNumber}: ${issueTitle}`,
    issueBody ?? '',
    '',
    PLAN_LOOP_ESCALATION_CONTRACT,
    '',
    '調査結果には、実装境界、依存候補、Touches 候補、未解決のリスクを含めてください。',
    '',
    verdictInstruction(['PASS', 'ESCALATE']),
  ].join('\n');
}

/**
 * PLAN stage prompt — planner agent, cwd = repo root.
 * @param {{ issueNumber: number, issueTitle: string, issueBody: string, mode?: string, research?: string, feedback?: string }} ctx
 * @returns {string}
 */
export function buildPlanPrompt(ctx) {
  const { issueNumber, issueTitle, issueBody, mode, research, feedback } = ctx;
  if (mode === 'plan-loop') {
    const lines = [
      marker(issueNumber, 'PLAN'),
      '',
      `以下の source issue と research 結果から、inner-loop で実行可能な実装 issue 1 本の plan を作成してください。`,
      '',
      `## source issue #${issueNumber}: ${issueTitle}`,
      issueBody ?? '',
      '',
      '## research',
      research ?? '',
    ];
    if (feedback) {
      lines.push('', '## PLAN-REVIEW feedback', feedback);
    }
    lines.push(
      '',
      PLAN_LOOP_ESCALATION_CONTRACT,
      '',
      '出力は以下の機械可読行を必ず含めてください。',
      'Title: <implementation issue title>',
      'Depends-on: #<n>, #<m>（依存が無い場合は "Depends-on: none" と明記。この行自体を省略しない）',
      'Touches: <path>, <path>',
      '',
      '続けて実装 agent がそのまま実行できる scoped implementation plan を書いてください。受け入れ基準・対象ファイル・検証方法（gate/tier）を明示してください。',
      '',
      verdictInstruction(['PLAN_READY', 'ESCALATE']),
    );
    return lines.join('\n');
  }

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
    IMPL_LOOP_ESCALATION_CONTRACT,
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
    IMPL_LOOP_ESCALATION_CONTRACT,
    '',
    '1 commit にまとめること（差し戻しの場合は amend）。明示 `git add <paths>` を使うこと（`git add -A` / `git add .` は禁止）。',
    '実 exit code を確認して検証すること（推測で GREEN と書かない）。',
    '',
    verdictInstruction(['IMPL_DONE', 'ESCALATE']),
  );
  return lines.join('\n');
}

/**
 * PLAN_REVIEW stage prompt — plan review stage, cwd = repo root.
 * @param {{ issueNumber: number, issueTitle: string, issueBody: string, research: string, plan: string }} ctx
 * @returns {string}
 */
export function buildPlanReviewPrompt(ctx) {
  const { issueNumber, issueTitle, issueBody, research, plan } = ctx;
  return [
    marker(issueNumber, 'PLAN-REVIEW'),
    '',
    '以下の plan-loop 出力を、実装 issue として起票してよいかレビューしてください。',
    '',
    `## source issue #${issueNumber}: ${issueTitle}`,
    issueBody ?? '',
    '',
    '## research',
    research ?? '',
    '',
    '## plan candidate',
    plan ?? '',
    '',
    PLAN_LOOP_ESCALATION_CONTRACT,
    '',
    'PASS は Title / Depends-on / Touches と実行可能な scoped plan が揃っている場合だけです。修正で足りる場合は CHANGES、裁可事項・目標不成立・依存衝突は ESCALATE してください。',
    '',
    verdictInstruction(['PASS', 'CHANGES', 'ESCALATE']),
  ].join('\n');
}

/**
 * REVIEW stage prompt — reviewer agent, cwd = worktree.
 * Note: receipt issuance is NOT part of this prompt — the driver stamps the
 * REVIEW receipt itself from the parsed verdict (see inner-loop.mjs
 * buildReceiptArgs), because an agent-issued `LATHE_AGENT=... node
 * scripts/receipt.mjs ...` command silently fails the Bash allowlist
 * (env-prefixed commands don't prefix-match `Bash(node scripts/receipt.mjs *)`).
 * @param {{ issueNumber: number, plan: string, headSha: string, reviewHistory?: string }} ctx
 * @returns {string}
 */
export function buildReviewPrompt(ctx) {
  const { issueNumber, plan, reviewHistory } = ctx;
  const lines = [
    marker(issueNumber, 'REVIEW'),
    '',
    '`.claude/skills/review/SKILL.md` の手順に従い、未コミットではなく main からの branch diff（現在の HEAD）を plan ＋ 該当 rubric に照らしてレビューしてください。',
    'diff は **inline の `git diff main...HEAD`** で取得すること。単純な diff 収集を subagent に委譲しない。',
    'PLAN と変更全体を一度に照合し、major/blocker は初回で出し切る（逐次開示しない）。major は plan/rubric/明文原則違反に限る。過剰 flag 禁止。',
    '',
    '**receipt（受領証）は driver が刻みます。あなたは発行しないでください**。最終行に `VERDICT: <TOKEN>` のみを出力すること。',
    '',
    '## plan',
    plan ?? '',
  ];
  if (reviewHistory) {
    lines.push(
      '',
      '## 前周までの REVIEW 履歴',
      reviewHistory,
      '',
      '前言と矛盾する新指摘を出す場合は、矛盾する前言を明示的に撤回し、その理由を述べてください。',
    );
  }
  lines.push('', verdictInstruction(['PASS', 'CHANGES', 'ESCALATE']));
  return lines.join('\n');
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
    '既知（KNOWN）は、IMPLEMENT 段に戻してコードまたは検証手順の変更で解消できる失敗に限ります。その場合は playbook の対処を明示してください（IMPLEMENT 段に差し戻します）。',
    'playbook P4 / Codex sandbox EPERM は既知でも実装コードでは直らない環境・backend 問題です。該当する場合は sandbox/backend 設定確認または VERIFY=Claude fallback を対処として書き、最終行は `VERDICT: ESCALATE` にしてください。`VERDICT: KNOWN` で IMPLEMENT に戻してはいけません。',
    '新規（NOVEL）の場合は evidence と仮説を添えてください（エスカレーションします）。',
    '',
    verdictInstruction(['KNOWN', 'NOVEL', 'ESCALATE']),
  ].join('\n');
}

export const STAGE_PROMPT_BUILDERS = {
  RESEARCH: buildResearchPrompt,
  PLAN: buildPlanPrompt,
  PLAN_REVIEW: buildPlanReviewPrompt,
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
