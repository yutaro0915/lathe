// Prompt templates for scripts/inner-loop.mjs stages.
// Split out from inner-loop.mjs for readability (ADR 0013 permits this split;
// scripts/ is outside the file-size rubric scope but long prompt strings hurt
// readability of the state machine itself).
//
// After the task-loop shrink (#116, ADR 0030 §2-3) only two local stages
// remain: IMPLEMENT (task loop, worktree) and PLAN (plan-task, repo root).
// Review runs on the PR via the review engine (#128); verify(tier=test) runs
// in CI. Each builder returns the full prompt string for
// `claude -p "<prompt>" --agent <name>`. Every prompt ends with the VERDICT
// instruction (ADR 0013 §機構詳細 verdict 規約): the agent must emit
// `VERDICT: <TOKEN>` as the last line, which the driver parses from the
// envelope's `result` field.

/**
 * Common issue/stage marker line, per ADR 0013 §2: "段 prompt に issue #<n> /
 * stage: <STAGE> マーカーを入れる（title に乗る保険）".
 * @param {number} issueNumber
 * @param {string} stage
 * @returns {string}
 */
function marker(issueNumber, stage) {
  return `issue #${issueNumber} / stage: ${stage}`;
}

/**
 * @param {string[]} tokens  valid VERDICT tokens for this stage, e.g. ['IMPL_DONE', 'ESCALATE']
 * @returns {string}
 */
function verdictInstruction(tokens) {
  return `最終行に必ず次の形式で verdict を出力してください（他の形式は不可）:\nVERDICT: <TOKEN>\n<TOKEN> は次のいずれか: ${tokens.join(' | ')}`;
}

// Agent-side ESCALATE is provisionally retained (#116 監査役裁定 3, 2026-07-07):
// escalation の intake 統一（関門一元化・agent 自発 verdict 廃止 = ADR 0030 追記 E）
// は #117 scope。それまでは現行の escalation 契約を維持する。
const IMPL_LOOP_ESCALATION_CONTRACT = [
  'escalation: plan（issue 本文）の前提が現実（コードの現状・依存状態）と乖離している場合は、その場で再計画せず ESCALATE してください。',
  'issue が未定義の契約・ロール割当・規約新設の決定を求めている（問題は述べられているが実装解が一意でない）場合は、最小変更を発明せず ESCALATE してください。',
  'VERDICT 不能・merge 失敗・main dirty は driver が機械的に検知・執行する条件です。あなた（agent）は検査しないでください。',
  'repo の清浄度判定は agent の仕事ではありません（untracked の扱いを含む定義判断も driver 管轄です）。',
].join(' ');

const EXTERNAL_SPACE_PATHS = [
  '`rubrics/`',
  '`.claude/skills/`',
  '`.claude/agents/`',
  '`.claude/hooks/`',
  '`design/test-failure-playbook.md`',
].join('・');

const PLAN_TASK_EXTERNAL_SPACE_CONTRACT = [
  `子 issue の plan に次の外部空間パスの編集を含めないでください: ${EXTERNAL_SPACE_PATHS}。`,
  '外部空間の変更が必要だと判断した場合は、その旨を選択肢として明記し VERDICT: ASK_PDM で終えてください（監査役の管轄です）。',
].join(' ');

/**
 * Format issue comments (裁定・申し送り, ADR 0031 §2) for prompt injection.
 * @param {Array<{ author?: { login?: string }, createdAt?: string, body?: string }>} comments
 * @returns {string} empty string when there are no comments
 */
export function formatIssueComments(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return '';
  return comments
    .map((c) => {
      const author = c?.author?.login ?? '(unknown)';
      const ts = c?.createdAt ?? '(no timestamp)';
      const body = String(c?.body ?? '').trim();
      return `### ${author} — ${ts}\n${body}`;
    })
    .join('\n\n');
}

// Standalone `VERDICT: <TOKEN>` lines are prompt noise inside injected review
// findings (the driver parses verdicts from agent OUTPUT, but a quoted verdict
// line invites confusion). Same shape as inner-loop-plan-task.mjs's local
// stripVerdictLine (kept local — prompts must not import from plan-task: cycle).
function stripVerdictLines(text) {
  return String(text ?? '').split(/\r?\n/).filter((line) => !/^VERDICT:\s*[A-Z_]+\s*$/.test(line.trim())).join('\n').trim();
}

/**
 * 所見注入セクション (#192 Major#2 / #201 分解 2). Formats review findings for
 * injection into the NEXT attempt's prompt, so a retry is an informed
 * correction (ADR 0035 §5 修正周回), not a blind regeneration.
 *
 * This is the single common mouth for review-feedback transport: today
 * PLAN_REVIEW RED → TASK_PLAN retry; the LAND review 前置 (#188) reuses this
 * builder for reviewer CHANGES → IMPLEMENT 差し戻し.
 * @param {{ source: string, findings: string | null | undefined }} p
 *   source: which review produced the findings (e.g. 'PLAN_REVIEW RED').
 * @returns {string} empty string when there are no findings to inject
 */
export function buildReviewFeedbackSection({ source, findings }) {
  const text = stripVerdictLines(findings);
  if (!text) return '';
  return [
    `## 前回 review 所見（${source}）`,
    '',
    '前回の出力は review で差し戻されました。以下の所見を反映して修正してください。',
    '指摘ごとに対応するか、対応しない場合はその理由を出力に明記してください（握り潰し禁止）。',
    '',
    text,
  ].join('\n');
}

/**
 * IMPLEMENT stage prompt — implementer agent, cwd = worktree.
 * The issue body IS the plan (ADR 0030 §2 "すべての task は plan を持って
 * 生まれる"; ADR 0031 §2 plan 本文 = issue body). Comments carry rulings and
 * scope addenda and are injected verbatim.
 * @param {{ issueNumber: number, issueTitle: string, issueBody: string, comments?: Array<object> }} ctx
 * @returns {string}
 */
export function buildImplementPrompt(ctx) {
  const { issueNumber, issueTitle, issueBody, comments } = ctx;
  const dirName = `inner-issue-${issueNumber}`;
  const branch = `inner/issue-${issueNumber}`;
  const lines = [
    marker(issueNumber, 'IMPLEMENT'),
    '',
    `以下の issue（本文 = plan）に従って issue #${issueNumber}: ${issueTitle} を実装してください。`,
    '',
    `あなたは implementer です。既に worktree \`${dirName}\`（branch \`${branch}\`）の**中**に居ます。その場で編集してください。**ネストした subagent を spawn しない・main（repo root）に書かない・別 worktree を切らない**。`,
    '`.claude/skills/implement/SKILL.md` に従ってください。着手前に `git rebase main` で current local `main` に合わせ、pristine な開始状態だけ `git reset --hard main` を使えます。編集後・コミット後に `reset --hard main` で成果物を消す運用は禁止です。完了前にも `git rebase main` し、競合したら `ESCALATE` してください。',
    '',
    '## issue（本文 = plan）',
    issueBody ?? '',
  ];
  const commentsBlock = formatIssueComments(comments);
  if (commentsBlock) {
    lines.push('', '## 裁定・申し送り（issue comments。scope 追記や確定裁定を含む。plan と併せて従うこと）', commentsBlock);
  }
  lines.push(
    '',
    IMPL_LOOP_ESCALATION_CONTRACT,
    '',
    '1 commit にまとめること。明示 `git add <paths>` を使うこと（`git add -A` / `git add .` は禁止）。',
    '実 exit code を確認して検証すること（推測で GREEN と書かない）。',
    '',
    verdictInstruction(['IMPL_DONE', 'ESCALATE']),
  );
  return lines.join('\n');
}

/**
 * LAND rework prompt (#201 分解 12 / #188 CHANGES 差し戻し) — implementer agent,
 * cwd = 元の IMPLEMENT と同一の task worktree。branch tip は PR として push 済み
 * なので、契約が IMPLEMENT と異なる:
 *   - 追い commit のみ (#188 設計要求「同一 worktree 追い commit・PR は push 更新」):
 *     push 済み commit の rebase / amend / reset は禁止（force-push 不可のため）。
 *     push・PR 操作は driver の管轄（新 PR・新 branch を作らない）。
 *   - 所見は buildReviewFeedbackSection 経由で注入 (#188 設計要求「注入形式」:
 *     所見注入の単一の口。指摘ごとの対応可否を出力させ、握り潰しを禁止)。全指摘を
 *     理由付きで却下する場合は commit ゼロでもよい — 対応表明を再 review が裁く。
 * @param {{ issueNumber: number, issueTitle: string, issueBody: string,
 *           comments?: Array<object>, reviewFeedback: string,
 *           round: number, maxRounds: number, prNumber?: number|null }} ctx
 * @returns {string}
 */
export function buildLandReworkPrompt(ctx) {
  const { issueNumber, issueTitle, issueBody, comments, reviewFeedback, round, maxRounds, prNumber } = ctx;
  const feedbackBlock = buildReviewFeedbackSection({
    source: `LAND review CHANGES — PR #${prNumber ?? '?'} 修正周回 ${round}/${maxRounds}`,
    findings: reviewFeedback,
  });
  if (!feedbackBlock) {
    throw new Error('buildLandReworkPrompt: reviewFeedback is required (CHANGES 差し戻しは所見が空では成立しない)');
  }
  const dirName = `inner-issue-${issueNumber}`;
  const branch = `inner/issue-${issueNumber}`;
  const lines = [
    marker(issueNumber, 'IMPLEMENT'),
    '',
    `issue #${issueNumber}: ${issueTitle} の実装は PR #${prNumber ?? '?'} として提出済みですが、LAND review で CHANGES（差し戻し）になりました。以下の所見を反映してください（修正周回 ${round}/${maxRounds}）。`,
    '',
    `あなたは implementer です。既に worktree \`${dirName}\`（branch \`${branch}\`）の**中**に居ます。その場で編集してください。**ネストした subagent を spawn しない・main（repo root）に書かない・別 worktree を切らない**。`,
    'この branch の既存 commit は PR として push 済みです。修正は**追い commit として積む**こと。`git rebase` / `git commit --amend` / `git reset` で push 済み commit を書き換えることは禁止です（force-push 不可）。push・PR 操作はしないでください（driver が push し、既存 PR が自動更新されます。新しい PR・branch を作らない）。',
    '',
    feedbackBlock,
    '',
    '## issue（本文 = plan。所見の解釈に必要な元の文脈）',
    issueBody ?? '',
  ];
  const commentsBlock = formatIssueComments(comments);
  if (commentsBlock) {
    lines.push('', '## 裁定・申し送り（issue comments）', commentsBlock);
  }
  lines.push(
    '',
    IMPL_LOOP_ESCALATION_CONTRACT,
    '',
    '変更は明示 `git add <paths>` で stage すること（`git add -A` / `git add .` は禁止）。',
    '全指摘を「対応しない」と判断した場合は commit を作らず、指摘ごとの理由を出力に列挙して IMPL_DONE で終えてよい（再 review が対応表明を審査します）。',
    '実 exit code を確認して検証すること（推測で GREEN と書かない）。',
    '',
    verdictInstruction(['IMPL_DONE', 'ESCALATE']),
  );
  return lines.join('\n');
}

/**
 * PLAN stage prompt for a plan-task — planner agent, cwd = repo root,
 * read-only (ADR 0030 §2: plan-task の終端は plan 確定＋子 issue 投函).
 *
 * `planFormat` is the full text of design/plan-format.md, injected fail-closed
 * (#116 が #142 を吸収): the driver reads the file at runtime and refuses to
 * start when it is missing/unreadable, and this builder refuses to build a
 * prompt without it. No silent fallback to an uninjected prompt.
 * @param {{ issueNumber: number, issueTitle: string, issueBody: string, comments?: Array<object>, planFormat: string }} ctx
 * @returns {string}
 */
export function buildPlanTaskPrompt(ctx) {
  const { issueNumber, issueTitle, issueBody, comments, planFormat } = ctx;
  if (typeof planFormat !== 'string' || planFormat.trim().length === 0) {
    throw new Error('buildPlanTaskPrompt: planFormat is required (fail-closed injection of design/plan-format.md, #142)');
  }
  const lines = [
    marker(issueNumber, 'PLAN'),
    '',
    `以下の needs-plan issue から、実装 task として投函できる子 issue 群の plan を作成してください。`,
    '',
    `## source issue #${issueNumber}: ${issueTitle}`,
    issueBody ?? '',
  ];
  const commentsBlock = formatIssueComments(comments);
  if (commentsBlock) {
    lines.push('', '## 裁定・申し送り（issue comments）', commentsBlock);
  }
  lines.push(
    '',
    '## plan format（正本 design/plan-format.md。子 issue の plan 本文はこの規約に従うこと）',
    '',
    planFormat.trim(),
    '',
    '## 出力契約',
    '',
    '各 task は「人間が数分（理想 1 分）で完全に理解できる範囲」に閉じるまで分割してください（ADR 0030 §5。分離して意味が保てる最小単位まで。1 行単位まで刻む趣旨ではありません）。',
    '検討した候補は必ず処置してください。処置は起票または却下の 2 種だけです。silent drop 禁止です。',
    '- 起票: 候補ごとに 1 つの子 issue block を出力してください。複数 block 可です。',
    '- 却下: `Rejected: <candidate> — <reason>` を 1 行で出力してください。',
    '',
    '各子 issue block は以下の機械可読行 3 行で始めてください。',
    'Title: <child issue title>',
    'Blocked-by: #<n>, plan#<k>（依存が無い場合は "Blocked-by: none" と明記。この行自体を省略しない。同一 plan 内の k 番目 block への依存は plan#<k> と書く）',
    'Touches: <path>, <path>',
    '',
    '各 block には、上記 plan format に従う plan 本文（子 issue の本文になる）を続けて書いてください。trivial クラスは軽量形（問題/修正方針/検証の 3 行〜）で可です。',
    '',
    PLAN_TASK_EXTERNAL_SPACE_CONTRACT,
    '',
    'PdM 判断が必要な選択肢（価値判断・scope 裁定・工数トレードオフ）に到達した場合は、選択肢と推奨を明記して VERDICT: ASK_PDM で終えてください（escalation ではなく正常終端です。ADR 0030 追記 E）。',
    '調査の結果、目標不成立・前提矛盾が判明した場合は ESCALATE してください。',
    '',
    verdictInstruction(['PLAN_READY', 'ASK_PDM', 'ESCALATE']),
  );
  return lines.join('\n');
}

/**
 * TASK_PLAN stage prompt — task-loop plan stage. Planner reads the issue and
 * produces a plan-format.md compliant plan for THIS issue (not child issues).
 * The driver posts the plan as a comment on the issue after PLAN_READY, then
 * PLAN_REVIEW evaluates it (ADR 0035 §1).
 *
 * `planFormat` is the full text of design/plan-format.md, injected fail-closed
 * (same contract as buildPlanTaskPrompt — #142 absorbed into #116).
 * `reviewFeedback` carries the previous PLAN_REVIEW RED findings on a retry
 * (#192 Major#2): the driver passes envelope.result so the planner corrects
 * the plan instead of regenerating it blind (ADR 0035 §5).
 * @param {{ issueNumber: number, issueTitle: string, issueBody: string, comments?: Array<object>, planFormat: string, reviewFeedback?: string }} ctx
 * @returns {string}
 */
export function buildTaskLoopPlanPrompt(ctx) {
  const { issueNumber, issueTitle, issueBody, comments, planFormat, reviewFeedback } = ctx;
  if (typeof planFormat !== 'string' || planFormat.trim().length === 0) {
    throw new Error('buildTaskLoopPlanPrompt: planFormat is required (fail-closed injection of design/plan-format.md, #142)');
  }
  const lines = [
    marker(issueNumber, 'TASK_PLAN'),
    '',
    `以下の issue の実装 plan を作成してください。plan-format.md の規約に従ってください。`,
    '',
    `## issue #${issueNumber}: ${issueTitle}`,
    issueBody ?? '',
  ];
  const commentsBlock = formatIssueComments(comments);
  if (commentsBlock) {
    lines.push('', '## 裁定・申し送り（issue comments）', commentsBlock);
  }
  const feedbackBlock = buildReviewFeedbackSection({ source: 'PLAN_REVIEW RED', findings: reviewFeedback });
  if (feedbackBlock) {
    lines.push('', feedbackBlock);
  }
  lines.push(
    '',
    '## plan format（正本 design/plan-format.md）',
    '',
    planFormat.trim(),
    '',
    '## 出力契約',
    '',
    'この issue 自体の実装 plan を plan-format.md に従って出力してください。',
    '子 issue を作成する必要はありません。この issue の acceptance criteria・変更対象・検証方法を明確にしてください。',
    '',
    IMPL_LOOP_ESCALATION_CONTRACT,
    '',
    verdictInstruction(['PLAN_READY', 'ESCALATE']),
  );
  return lines.join('\n');
}

/**
 * PLAN_REVIEW stage prompt — machine plan review (ADR 0035 §1). An independent
 * reviewer agent evaluates the plan produced by TASK_PLAN. Returns PASS when
 * the plan is actionable and RED when critical issues are found (driver retries
 * TASK_PLAN up to MAX_PLAN_REVIEW_RETRIES times).
 *
 * `comments` (裁定・申し送り) are injected so the reviewer holds the same
 * context the planner planned with — without them, comment-driven plan
 * decisions look unfounded and cause false RED (#192 Minor#4).
 * @param {{ issueNumber: number, issueTitle: string, issueBody: string, comments?: Array<object>, planText: string }} ctx
 * @returns {string}
 */
export function buildPlanReviewPrompt(ctx) {
  const { issueNumber, issueTitle, issueBody, comments, planText } = ctx;
  const lines = [
    marker(issueNumber, 'PLAN_REVIEW'),
    '',
    `以下の plan を ADR 0035 §1 の機械 plan review として検査してください。`,
    '',
    `## issue #${issueNumber}: ${issueTitle}`,
    issueBody ?? '',
  ];
  const commentsBlock = formatIssueComments(comments);
  if (commentsBlock) {
    lines.push('', '## 裁定・申し送り（issue comments。planner はこの文脈を前提に plan を作っている。審査でも同じ前提に立つこと）', commentsBlock);
  }
  lines.push(
    '',
    '## 検査対象 plan',
    '',
    planText ?? '(plan not provided)',
    '',
    '## 検査項目',
    '',
    '1. plan-format 準拠（acceptance criteria・変更対象・検証方法が明記されているか）',
    '2. 実装可能性（曖昧な前提・未定義の依存・解が一意でない設計判断はないか）',
    '3. scope の明確さ（acceptance criteria が機械的に検証可能か）',
    '',
    'PASS: 上記すべて問題なし。実装を続行できる。',
    'RED: 重大な問題あり。問題点を具体的に列挙してください（planner が修正に使います）。',
    '',
    verdictInstruction(['PASS', 'RED']),
  );
  return lines.join('\n');
}

export const STAGE_PROMPT_BUILDERS = {
  PLAN: buildPlanTaskPrompt,
  TASK_PLAN: buildTaskLoopPlanPrompt,
  PLAN_REVIEW: buildPlanReviewPrompt,
  IMPLEMENT: buildImplementPrompt,
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
