// orchestrator-explain.mjs — EXPLAIN dispatch の完走後処理（#201 分解 13）。
// 分類規則 2（issue #201）: 教材 = needs-review × plan あり × 教材なし →
// explain runner ＋ explains/ 正本の自動 PR → done-explain。
//
// explain runner（claude -p、SETUP.md §6 正規形）の allowed-tools は読み取り＋
// `explains/**` への書き込みだけで、**正本の git 着地は解説 loop の終端に含まれない**
// （SKILL.md「最小権限の維持」）。本モジュールがその landing を機械化する:
//   ① runner 完走（exit 0）後に explains/ の新規 md（untracked・対象 issue の slug）を検出
//   ② 一時 worktree の専用 branch に commit → landBranch 再利用の 3 手
//      （push → PR → auto-merge arm）。PR body は **Refs #N のみ・Closes しない**
//      — 解説は対象 task のライフサイクルと無関係（close すると解説が task を殺す事故、
//      SKILL.md 終端処理）。CI は md に no-op なので即着地する
//   ③ done-explain を対象 issue へ**冪等付与** — skill の label 遷移は
//      「needs-explain が無いと done-explain も付かない」edge を持つ（2026-07-07 実測。
//      orchestrator の EXPLAIN は needs-review 起点で needs-explain を経由しない）ため、
//      機械側で保証する
// 重複生成の防止は 2 層: classify が done-explain label **または** explains/ の対象
// slug 正本を「教材あり」と扱い（orchestrator-classify.mjs）、実行中〜完走の窓は
// 既存の live マーカー（orchestrator.mjs）が塞ぐ。
//
// 全段 非致命 — landing/label が失敗しても orchestrator のパスは止めない
// （教材の耐久コピーは Discussion 側にあり、正本収載は運用側が後から PR で拾える）。
// 純関数（parse/命名/commit message/PR body/label args/repair 判定）は export して
// テスト対象。side effect（git/gh/fs）は下段に隔離し deps 注入可能にする。

import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './inner-loop-core.mjs';
import { landBranch } from './inner-loop-land.mjs';
import { REPO_OWNER, REPO_NAME } from './orchestrator-derive.mjs';
import { DONE_EXPLAIN_LABEL, SKIP_NON_TASK } from './orchestrator-classify.mjs';

// --- Pure helpers ---

/**
 * `git status --porcelain -- explains/` の出力 → 新規（untracked `??`）の
 * explains/*.md 名（`explains/` からの相対名・昇順）。tracked 教材の変更（` M`）は
 * 対象外 — publish 後の教材は不変（SKILL.md）で、改訂は新版 = 新規ファイルになる。
 * @param {string} porcelain
 * @returns {string[]}
 */
export function parseNewExplainFiles(porcelain) {
  const files = [];
  for (const line of String(porcelain ?? '').split('\n')) {
    if (!line.startsWith('?? ')) continue;
    let path = line.slice(3).trim();
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (!path.startsWith('explains/') || !path.endsWith('.md')) continue;
    files.push(path.slice('explains/'.length));
  }
  return files.sort();
}

/**
 * 教材ファイル名の slug 規約 `YYYY-MM-DD-issue<N>-<slug>.md`（実例:
 * `2026-07-07-issue116-task-loop-shrink.md`）から対象 issue 番号を引く。
 * PR 教材（`...-pr<N>-...`）や規約外の名前は null。
 * @param {string} name  explains/ からの相対ファイル名
 * @returns {number | null}
 */
export function explainIssueNumberFromName(name) {
  const m = /^\d{4}-\d{2}-\d{2}-issue(\d+)(?:[-.]|$)/.exec(String(name ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * 教材ファイル名集合 → 「explains/ に正本がある issue 番号」集合。
 * classify の「教材あり」判定（重複生成防止の第 2 の証拠、label が第 1）に使う。
 * @param {string[]} names
 * @returns {Set<number>}
 */
export function explainedIssueNumbersFrom(names) {
  const set = new Set();
  for (const name of names ?? []) {
    const n = explainIssueNumberFromName(name);
    if (n !== null) set.add(n);
  }
  return set;
}

/**
 * @param {string[]} names
 * @param {number} issueNumber
 * @returns {string[]} 対象 issue の slug を持つ名前だけ
 */
export function matchExplainFilesForIssue(names, issueNumber) {
  return (names ?? []).filter((name) => explainIssueNumberFromName(name) === issueNumber);
}

/**
 * explains landing の branch/worktree 命名。`inner/issue-<n>` とは意図的に別系
 * — driver 産 PR（SKIP_DRIVER_PR）に誤分類させない。
 * @param {number} issueNumber
 * @returns {{ branch: string, dirName: string }}
 */
export function explainBranchFor(issueNumber) {
  return { branch: `explain/issue-${issueNumber}`, dirName: `explain-issue-${issueNumber}` };
}

/**
 * landing commit のメッセージ。先頭 commit の subject/body がそのまま PR の
 * title/body になる（landBranch の規約）。Closes は書かない。
 * @param {number} issueNumber
 * @param {string[]} files
 * @returns {{ subject: string, body: string }}
 */
export function buildExplainCommitMessage(issueNumber, files) {
  const subject = `explains: issue #${issueNumber} 教材の正本収載（explain runner 完走の自動 PR）`;
  const body = [
    'orchestrator の EXPLAIN 完走後処理（#201 分解 13）による explains/ 正本の自動 landing。',
    '',
    ...(files ?? []).map((f) => `- explains/${f}`),
    '',
    `Refs #${issueNumber}`,
  ].join('\n');
  return { subject, body };
}

/**
 * landBranch へ注入する PR body builder（`deps.buildPrBody`）。既定の
 * buildPrBodyWithCloses と違い **Closes を書かず Refs #N を保証**する
 * — merge しても対象 issue を close しない（解説と task のライフサイクルは独立）。
 * @param {string} body  先頭 commit の body
 * @param {number} issueNumber
 * @returns {string}
 */
export function buildExplainPrBody(body, issueNumber) {
  const base = String(body ?? '').trim();
  if (new RegExp(`\\bRefs #${issueNumber}\\b`, 'i').test(base)) return base;
  const marker = `Refs #${issueNumber}`;
  return base ? `${base}\n\n${marker}` : marker;
}

/**
 * done-explain 冪等付与の gh 引数。REST POST は既に付いていても 200 を返す
 * （冪等）。GraphQL 系（gh issue/pr edit）は Projects classic 廃止エラーで
 * 失敗する（2026-07-07 実測、SKILL.md 終端処理）ため REST を使う。
 * @param {number} issueNumber
 * @returns {string[]}
 */
export function buildDoneExplainLabelArgs(issueNumber) {
  return [
    'api', '-X', 'POST',
    `repos/${REPO_OWNER}/${REPO_NAME}/issues/${issueNumber}/labels`,
    '-f', `labels[]=${DONE_EXPLAIN_LABEL}`,
  ];
}

/**
 * label repair の判定: explains/ に正本があるのに done-explain が無い issue
 * （完走後処理の label POST が失敗した窓の自己修復。冪等付与だから再実行できる）。
 * @param {{ number: number, labels?: string[] }} issue
 * @param {Set<number>} explainedIssueNumbers
 * @returns {boolean}
 */
export function needsDoneExplainRepair(issue, explainedIssueNumbers) {
  if (!explainedIssueNumbers?.has(issue?.number)) return false;
  return !(issue?.labels ?? []).some((l) => String(l).toLowerCase() === DONE_EXPLAIN_LABEL);
}

/**
 * classify 決定リスト → repair 対象（task issue のみ — orchestrator は対象外
 * SKIP_NON_TASK の issue に触らない）。
 * @param {Array<{ kind: string, class: string, issue?: object }>} decisions
 * @param {Set<number>} explainedIssueNumbers
 * @returns {object[]}
 */
export function selectDoneExplainRepairs(decisions, explainedIssueNumbers) {
  return (decisions ?? []).filter((d) => d.kind === 'issue' && d.issue
    && d.class !== SKIP_NON_TASK && needsDoneExplainRepair(d.issue, explainedIssueNumbers));
}

/**
 * dry-run 用の完走後処理 1 行表示。
 * @param {number} issueNumber
 * @returns {string}
 */
export function formatExplainPostProcessPlan(issueNumber) {
  return `EXPLAIN #${issueNumber} 完走後処理 — explains/ 新規 md（issue${issueNumber} slug）検出 → `
    + `${explainBranchFor(issueNumber).branch} に commit → push → PR（Refs #${issueNumber}・Closes しない）→ `
    + 'auto-merge arm ＋ done-explain 冪等付与';
}

// --- Side effects（git / gh / fs・deps 注入可） ---

/**
 * explains/ の教材ファイル名一覧（tracked/untracked を区別しない — classify の
 * 「教材あり」証拠は実在で足りる）。ディレクトリが無ければ空。
 * @param {{ readdirSync?: Function }} deps
 * @returns {string[]}
 */
export function listExplainFileNames(deps = {}) {
  const readdir = deps.readdirSync ?? readdirSync;
  try {
    return readdir(join(REPO_ROOT, 'explains')).filter((name) => String(name).endsWith('.md'));
  } catch {
    return [];
  }
}

/**
 * runner 完走後の新規教材検出。対象 issue の slug に一致するものが landing 対象、
 * 一致しない新規 md は others（他 runner の生成中ファイルを巻き込まない）。
 * @param {number} issueNumber
 * @param {{ spawnSync?: Function }} deps
 * @returns {{ ok: boolean, reason?: string, files: string[], others: string[] }}
 */
export function detectNewExplainFiles(issueNumber, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const r = run('git', ['status', '--porcelain', '--', 'explains/'],
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1e7 });
  if (r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.stdout || 'git status failed').slice(0, 300), files: [], others: [] };
  }
  const all = parseNewExplainFiles(r.stdout ?? '');
  const files = matchExplainFilesForIssue(all, issueNumber);
  return { ok: true, files, others: all.filter((name) => !files.includes(name)) };
}

/**
 * explains/ 正本の自動 landing: 一時 worktree の専用 branch に commit →
 * landBranch 再利用（push → PR（Refs のみ）→ auto-merge arm）。成功時は
 * main worktree の untracked 原本を削除する（merge 後の pull と衝突させない。
 * 内容は push 済み branch と Discussion にある）。失敗はすべて非致命 —
 * untracked 原本は残るので運用側が後から PR で拾える（SKILL.md の既定経路）。
 * @param {number} issueNumber
 * @param {string[]} files  explains/ からの相対名（detectNewExplainFiles の files）
 * @param {{ spawnSync?: Function, landBranch?: Function, copyFileSync?: Function,
 *           mkdirSync?: Function, rmSync?: Function }} deps
 * @returns {{ ok: boolean, reason?: string }}
 */
export function landExplains(issueNumber, files, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const land = deps.landBranch ?? landBranch;
  const copy = deps.copyFileSync ?? copyFileSync;
  const mkdir = deps.mkdirSync ?? mkdirSync;
  const rm = deps.rmSync ?? rmSync;
  const { branch, dirName } = explainBranchFor(issueNumber);
  const wtPath = join(REPO_ROOT, '.lathe', 'worktrees', dirName);
  const git = (args) => run('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1e7 });

  // stale 残骸（前回失敗）は作り直す。branch は landing 専用の使い捨て。
  git(['worktree', 'remove', wtPath, '--force']);
  git(['branch', '-D', branch]);
  const added = git(['worktree', 'add', wtPath, '-b', branch, 'main']);
  if (added.status !== 0) {
    return { ok: false, reason: `git worktree add failed: ${(added.stderr || added.stdout || '').slice(0, 300)}` };
  }
  try {
    for (const name of files) {
      const dest = join(wtPath, 'explains', name);
      mkdir(dirname(dest), { recursive: true });
      copy(join(REPO_ROOT, 'explains', name), dest);
    }
    const staged = git(['-C', wtPath, 'add', '--', ...files.map((name) => `explains/${name}`)]);
    if (staged.status !== 0) {
      return { ok: false, reason: `git add failed: ${(staged.stderr || staged.stdout || '').slice(0, 300)}` };
    }
    const msg = buildExplainCommitMessage(issueNumber, files);
    const committed = git(['-C', wtPath, 'commit', '-m', msg.subject, '-m', msg.body]);
    if (committed.status !== 0) {
      return { ok: false, reason: `git commit failed: ${(committed.stderr || committed.stdout || '').slice(0, 300)}` };
    }
    const landed = land(branch, issueNumber, { buildPrBody: buildExplainPrBody });
    if (!landed.ok) {
      return { ok: false, reason: `landing failed: ${String(landed.output ?? '').slice(-300)}` };
    }
    for (const name of files) {
      try { rm(join(REPO_ROOT, 'explains', name), { force: true }); } catch { /* 非致命 — pull 時に手当て */ }
    }
    return { ok: true };
  } finally {
    git(['worktree', 'remove', wtPath, '--force']);
    git(['branch', '-D', branch]); // push 済み — PR head は remote 側に残る
  }
}

/**
 * done-explain の冪等付与（REST・非致命）。
 * @param {number} issueNumber
 * @param {{ spawnSync?: Function }} deps
 * @returns {{ ok: boolean, reason?: string }}
 */
export function ensureDoneExplainLabel(issueNumber, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const r = run('gh', buildDoneExplainLabelArgs(issueNumber),
    { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1e7 });
  if (r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.stdout || 'gh api failed').slice(0, 300) };
  }
  return { ok: true };
}

/**
 * EXPLAIN 完走後処理の入口（orchestrator.mjs が exit 0 の EXPLAIN 完了時に呼ぶ）。
 * ①新規教材の検出と landing ②done-explain 冪等付与。すべて非致命。
 * @param {number} issueNumber
 * @param {{ log?: Function } & Parameters<typeof landExplains>[2]} deps
 * @returns {{ landed: boolean, files: string[], labelOk: boolean }}
 */
export function runExplainPostProcess(issueNumber, deps = {}) {
  const writeLog = deps.log ?? (() => {});
  const result = { landed: false, files: [], labelOk: false };

  const detected = detectNewExplainFiles(issueNumber, deps);
  if (!detected.ok) {
    writeLog(`explain post #${issueNumber}: 新規教材の検出に失敗（非致命・landing skip）: ${detected.reason}`);
  } else {
    for (const other of detected.others) {
      writeLog(`explain post #${issueNumber}: explains/${other} は slug が対象外 — landing しない（他 runner の生成物の可能性）`);
    }
    if (detected.files.length === 0) {
      writeLog(`explain post #${issueNumber}: 新規 explains/ なし — landing なし`);
    } else {
      const landed = landExplains(issueNumber, detected.files, deps);
      if (landed.ok) {
        result.landed = true;
        result.files = detected.files;
        writeLog(`explain post #${issueNumber}: explains/ 正本を自動 PR に landing（Refs #${issueNumber}・auto-merge arm）: ${detected.files.join(', ')}`);
      } else {
        writeLog(`explain post #${issueNumber}: landing failed（非致命・原本は explains/ に残置 — 運用側が後から PR で拾う）: ${landed.reason}`);
      }
    }
  }

  const label = ensureDoneExplainLabel(issueNumber, deps);
  result.labelOk = label.ok;
  writeLog(label.ok
    ? `explain post #${issueNumber}: done-explain を冪等付与`
    : `explain post #${issueNumber}: done-explain 付与に失敗（非致命 — explains/ 正本 evidence と次パスの repair が塞ぐ）: ${label.reason}`);
  return result;
}
