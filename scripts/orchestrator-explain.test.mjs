// Tests for the EXPLAIN 完走後処理 (#201 分解 13): explains/ 新規教材の検出、
// slug 規約（issue<N>）、landing の 3 手（landBranch 再利用・Refs のみ・Closes なし）、
// done-explain 冪等付与と repair 判定。side effect は deps 注入で固定する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDoneExplainLabelArgs,
  buildExplainCommitMessage,
  buildExplainPrBody,
  detectNewExplainFiles,
  ensureDoneExplainLabel,
  explainBranchFor,
  explainIssueNumberFromName,
  explainedIssueNumbersFrom,
  formatExplainPostProcessPlan,
  landExplains,
  matchExplainFilesForIssue,
  needsDoneExplainRepair,
  parseNewExplainFiles,
  runExplainPostProcess,
  selectDoneExplainRepairs,
} from './orchestrator-explain.mjs';
import { landBranch } from './inner-loop-land.mjs';
import { isDriverPrBranch } from './orchestrator-derive.mjs';
import { CLASS_IMPLEMENT, SKIP_NON_TASK, WAIT_APPROVAL } from './orchestrator-classify.mjs';

// --- parseNewExplainFiles（porcelain → 新規教材名） ---

test('parseNewExplainFiles: untracked の explains/*.md だけ・昇順・quote 除去', () => {
  const porcelain = [
    '?? explains/2026-07-08-issue206-bar.md',
    ' M explains/2026-07-07-issue116-task-loop-shrink.md', // tracked 変更は対象外（publish 後不変）
    '?? explains/note.txt', // md 以外は対象外
    '?? scripts/stray.mjs', // explains/ 外は対象外
    '?? "explains/quoted.md"', // porcelain が quote する path
    '?? explains/2026-07-08-issue206-abc.md',
    '',
  ].join('\n');
  assert.deepEqual(parseNewExplainFiles(porcelain), [
    '2026-07-08-issue206-abc.md',
    '2026-07-08-issue206-bar.md',
    'quoted.md',
  ]);
  assert.deepEqual(parseNewExplainFiles(''), []);
});

// --- slug 規約（YYYY-MM-DD-issue<N>-<slug>.md） ---

test('explainIssueNumberFromName: issue slug から番号を引く（pr slug・規約外は null）', () => {
  assert.equal(explainIssueNumberFromName('2026-07-07-issue116-task-loop-shrink.md'), 116);
  assert.equal(explainIssueNumberFromName('2026-07-08-issue206.md'), 206, '拡張子直結も slug として有効');
  assert.equal(explainIssueNumberFromName('2026-07-07-pr110-receipt-to-ci.md'), null, 'PR 教材は issue 番号を持たない');
  assert.equal(explainIssueNumberFromName('issue116-no-date.md'), null, '日付 prefix なしは規約外');
  assert.equal(explainIssueNumberFromName(''), null);
});

test('matchExplainFilesForIssue: 番号は完全一致（issue116 と issue1160 を混同しない）', () => {
  const names = ['2026-07-07-issue116-a.md', '2026-07-07-issue1160-b.md', '2026-07-07-pr116-c.md'];
  assert.deepEqual(matchExplainFilesForIssue(names, 116), ['2026-07-07-issue116-a.md']);
  assert.deepEqual([...explainedIssueNumbersFrom(names)].sort((a, b) => a - b), [116, 1160]);
});

// --- branch 命名（driver 産 PR に誤分類させない） ---

test('explainBranchFor: explain/issue-<n> — driver 産（inner/issue-<n>）とは別系', () => {
  const { branch, dirName } = explainBranchFor(206);
  assert.equal(branch, 'explain/issue-206');
  assert.equal(dirName, 'explain-issue-206');
  assert.equal(isDriverPrBranch(branch), false, 'SKIP_DRIVER_PR に落ちない（非 driver 産 PR として扱われる）');
});

// --- commit message / PR body（Refs のみ・Closes 禁止） ---

test('buildExplainCommitMessage: subject が PR title・body に対象ファイルと Refs、Closes なし', () => {
  const { subject, body } = buildExplainCommitMessage(206, ['2026-07-08-issue206-abc.md']);
  assert.match(subject, /^explains: issue #206 /);
  assert.match(body, /- explains\/2026-07-08-issue206-abc\.md/);
  assert.match(body, /Refs #206/);
  assert.ok(!/Closes/i.test(subject + body), '解説 PR は対象 issue を close しない');
});

test('buildExplainPrBody: Refs #N を保証（既にあれば追記しない・Closes は決して書かない）', () => {
  assert.equal(buildExplainPrBody('', 206), 'Refs #206');
  assert.equal(buildExplainPrBody('本文\n\nRefs #206', 206), '本文\n\nRefs #206');
  assert.equal(buildExplainPrBody('本文', 206), '本文\n\nRefs #206');
  assert.ok(!/Closes/i.test(buildExplainPrBody('本文', 206)));
});

test('landBranch: deps.buildPrBody 注入で Refs のみの PR body になる（explains 自動 PR の 3 手再利用）', () => {
  const calls = [];
  const fakeRun = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'log') {
      return { status: 0, stdout: 'explains: issue #206 教材の正本収載\n\n本文\n\nRefs #206\0', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const r = landBranch('explain/issue-206', 206, { spawnSync: fakeRun, buildPrBody: buildExplainPrBody });
  assert.equal(r.ok, true);
  const prCreate = calls.find((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'create');
  const body = prCreate[prCreate.indexOf('--body') + 1];
  assert.match(body, /Refs #206/);
  assert.ok(!/Closes #206/i.test(body), 'merge しても対象 issue を close しない');
  assert.ok(calls.some((c) => c[0] === 'git' && c[1] === 'push'), 'push');
  assert.ok(calls.some((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'merge'), 'auto-merge arm');
});

test('landBranch: 既定（注入なし）は従来どおり Closes #N を付ける', () => {
  const calls = [];
  const fakeRun = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'log') return { status: 0, stdout: 'feat: x\0', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  assert.equal(landBranch('inner/issue-7', 7, { spawnSync: fakeRun }).ok, true);
  const prCreate = calls.find((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'create');
  assert.match(prCreate[prCreate.indexOf('--body') + 1], /Closes #7/);
});

// --- done-explain 冪等付与（REST）と repair 判定 ---

test('buildDoneExplainLabelArgs: REST POST（gh pr/issue edit は Projects classic 廃止エラーで不可）', () => {
  assert.deepEqual(buildDoneExplainLabelArgs(206), [
    'api', '-X', 'POST', 'repos/yutaro0915/lathe/issues/206/labels', '-f', 'labels[]=done-explain',
  ]);
});

test('ensureDoneExplainLabel: gh 成功で ok・失敗は非致命の reason', () => {
  assert.deepEqual(ensureDoneExplainLabel(206, { spawnSync: () => ({ status: 0, stdout: '[]' }) }), { ok: true });
  const failed = ensureDoneExplainLabel(206, { spawnSync: () => ({ status: 1, stderr: 'boom' }) });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /boom/);
});

test('needsDoneExplainRepair: explains/ 正本あり × done-explain なし のときだけ true', () => {
  const explained = new Set([206]);
  assert.equal(needsDoneExplainRepair({ number: 206, labels: ['task-request'] }, explained), true);
  assert.equal(needsDoneExplainRepair({ number: 206, labels: ['Done-Explain'] }, explained), false, 'label は大文字小文字を区別しない');
  assert.equal(needsDoneExplainRepair({ number: 207, labels: [] }, explained), false, '正本なし');
});

test('selectDoneExplainRepairs: task issue のみ（SKIP_NON_TASK と PR は触らない）', () => {
  const explained = new Set([10, 11, 12]);
  const decisions = [
    { kind: 'issue', number: 10, class: CLASS_IMPLEMENT, issue: { number: 10, labels: [] } },
    { kind: 'issue', number: 11, class: SKIP_NON_TASK, issue: { number: 11, labels: [] } },
    { kind: 'issue', number: 12, class: WAIT_APPROVAL, issue: { number: 12, labels: ['done-explain'] } },
    { kind: 'pr', number: 300, class: 'PR_REVIEW', pr: {} },
  ];
  assert.deepEqual(selectDoneExplainRepairs(decisions, explained).map((d) => d.number), [10]);
});

// --- detectNewExplainFiles（対象 slug と対象外の分離） ---

test('detectNewExplainFiles: 対象 issue の slug だけ files・他は others（他 runner の生成物を巻き込まない）', () => {
  const porcelain = '?? explains/2026-07-08-issue206-abc.md\n?? explains/2026-07-08-issue999-zzz.md\n';
  const r = detectNewExplainFiles(206, { spawnSync: () => ({ status: 0, stdout: porcelain }) });
  assert.deepEqual(r, {
    ok: true,
    files: ['2026-07-08-issue206-abc.md'],
    others: ['2026-07-08-issue999-zzz.md'],
  });
});

test('detectNewExplainFiles: git status 失敗は ok:false（非致命に扱う材料）', () => {
  const r = detectNewExplainFiles(206, { spawnSync: () => ({ status: 128, stderr: 'not a git repo' }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a git repo/);
  assert.deepEqual(r.files, []);
});

// --- landExplains（一時 worktree → commit → landBranch 3 手 → 掃除） ---

function fakeGitEnv(overrides = {}) {
  const calls = [];
  const copies = [];
  const removed = [];
  const deps = {
    spawnSync: (cmd, args) => {
      calls.push([cmd, ...args]);
      const fail = overrides.failOn?.(cmd, args);
      return fail ?? { status: 0, stdout: '', stderr: '' };
    },
    landBranch: overrides.landBranch ?? ((branch, issueNumber, opts) => {
      calls.push(['landBranch', branch, String(issueNumber), opts?.buildPrBody === buildExplainPrBody ? 'refs-body' : 'other-body']);
      return { ok: true, output: '' };
    }),
    copyFileSync: (src, dest) => copies.push([src, dest]),
    mkdirSync: () => {},
    rmSync: (path) => removed.push(path),
  };
  return { calls, copies, removed, deps };
}

test('landExplains: worktree 作成 → copy → add/commit → landBranch(Refs body) → 原本削除 → 掃除', () => {
  const { calls, copies, removed, deps } = fakeGitEnv();
  const r = landExplains(206, ['2026-07-08-issue206-abc.md'], deps);
  assert.equal(r.ok, true);
  const flat = calls.map((c) => c.join(' '));
  assert.ok(flat.some((c) => c.includes('worktree add') && c.includes('-b explain/issue-206') && c.endsWith('main')), '専用 branch を main から作る');
  assert.ok(flat.some((c) => c.includes('add -- explains/2026-07-08-issue206-abc.md')), '明示パスの git add');
  assert.ok(flat.some((c) => c.startsWith('git -C') && c.includes('commit')), '一時 worktree 内で commit');
  assert.ok(flat.some((c) => c === 'landBranch explain/issue-206 206 refs-body'), 'landBranch を Refs body builder 付きで再利用');
  assert.equal(copies.length, 1, '新規教材を一時 worktree へ copy');
  assert.equal(removed.length, 1, '成功後に untracked 原本を削除（merge 後 pull と衝突させない）');
  assert.ok(removed[0].endsWith('explains/2026-07-08-issue206-abc.md'));
  const landIdx = calls.findIndex((c) => c[0] === 'landBranch');
  assert.ok(flat.slice(landIdx + 1).some((c) => c.includes('worktree remove')), 'finally で worktree を掃除');
  assert.ok(flat.slice(landIdx + 1).some((c) => c.includes('branch -D')), 'ローカル branch も掃除（PR head は remote）');
});

test('landExplains: landing 失敗は非致命 — 原本は残置・worktree は掃除', () => {
  const { calls, removed, deps } = fakeGitEnv({
    landBranch: () => ({ ok: false, output: 'gh pr create failed' }),
  });
  const r = landExplains(206, ['2026-07-08-issue206-abc.md'], deps);
  assert.equal(r.ok, false);
  assert.match(r.reason, /landing failed/);
  assert.equal(removed.length, 0, '原本を消さない（運用側が後から PR で拾う）');
  assert.ok(calls.map((c) => c.join(' ')).filter((c) => c.includes('worktree remove')).length >= 2, 'stale 掃除＋finally 掃除');
});

test('landExplains: worktree add 失敗なら landBranch まで進まない', () => {
  const { calls, deps } = fakeGitEnv({
    failOn: (cmd, args) => (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add'
      ? { status: 1, stdout: '', stderr: 'add failed' } : null),
  });
  const r = landExplains(206, ['2026-07-08-issue206-abc.md'], deps);
  assert.equal(r.ok, false);
  assert.match(r.reason, /worktree add failed/);
  assert.ok(!calls.some((c) => c[0] === 'landBranch'));
});

// --- runExplainPostProcess（入口・全段 非致命） ---

test('runExplainPostProcess: 新規教材あり → landing ＋ done-explain 付与・対象外 slug は landing しない', () => {
  const logs = [];
  const porcelain = '?? explains/2026-07-08-issue206-abc.md\n?? explains/2026-07-08-issue999-zzz.md\n';
  const { deps } = fakeGitEnv();
  const result = runExplainPostProcess(206, {
    ...deps,
    spawnSync: (cmd, args) => {
      if (cmd === 'git' && args[0] === 'status') return { status: 0, stdout: porcelain };
      return { status: 0, stdout: '', stderr: '' };
    },
    log: (msg) => logs.push(msg),
  });
  assert.deepEqual(result, { landed: true, files: ['2026-07-08-issue206-abc.md'], labelOk: true });
  assert.ok(logs.some((m) => m.includes('issue999') && m.includes('対象外')), '他 runner の生成物は巻き込まない');
});

test('runExplainPostProcess: 新規教材なしでも done-explain は冪等付与する（label 遷移 edge の機械保証）', () => {
  const logs = [];
  const { deps } = fakeGitEnv();
  const result = runExplainPostProcess(206, {
    ...deps,
    spawnSync: (cmd, args) => {
      if (cmd === 'git' && args[0] === 'status') return { status: 0, stdout: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    log: (msg) => logs.push(msg),
  });
  assert.deepEqual(result, { landed: false, files: [], labelOk: true });
  assert.ok(logs.some((m) => m.includes('done-explain を冪等付与')));
});

// --- dry-run 表示 ---

test('formatExplainPostProcessPlan: branch・Refs・Closes しない・冪等付与を明示', () => {
  const line = formatExplainPostProcessPlan(206);
  assert.match(line, /EXPLAIN #206 完走後処理/);
  assert.match(line, /explain\/issue-206/);
  assert.match(line, /Refs #206・Closes しない/);
  assert.match(line, /done-explain 冪等付与/);
});
