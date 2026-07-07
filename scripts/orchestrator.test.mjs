// Tests for the dispatch shell's pure parts (#201 分解 9): CLI args, PID lock,
// worktree 非依存の live マーカー実行中判定, dispatch spec（SETUP.md §6 正規形
// を含む）, escalation を故障と数えない circuit breaker, Touches 直列化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLASS_SLUGS,
  EXPLAIN_ALLOWED_TOOLS,
  OUTCOME_ESCALATION, OUTCOME_FAILURE, OUTCOME_SUCCESS,
  applyBreaker,
  buildDispatchSpec,
  buildExplainPrompt,
  classifyChildOutcome,
  decideLockAction,
  deriveRunningTargets,
  liveMarkerName,
  parseLiveMarker,
  parseOrchestratorArgs,
  pickNextDispatch,
  runDispatch,
} from './orchestrator.mjs';
import {
  CLASS_EXPLAIN, CLASS_IMPLEMENT, CLASS_PLAN, CLASS_PR_REVIEW,
} from './orchestrator-classify.mjs';
import { INNER_SETTINGS_PATH } from './inner-loop-backends.mjs';

// --- parseOrchestratorArgs ---

test('parseOrchestratorArgs: defaults are max=5, max-failures=3, no dry-run', () => {
  assert.deepEqual(parseOrchestratorArgs([]), { max: 5, maxFailures: 3, dryRun: false });
});

test('parseOrchestratorArgs: flags in both forms; invalid values throw', () => {
  assert.deepEqual(
    parseOrchestratorArgs(['--max', '2', '--max-failures=0', '--dry-run']),
    { max: 2, maxFailures: 0, dryRun: true },
  );
  assert.throws(() => parseOrchestratorArgs(['--max', '0']), /positive integer/);
  assert.throws(() => parseOrchestratorArgs(['--max-failures', '-1']), /non-negative/);
  assert.throws(() => parseOrchestratorArgs(['--bogus']), /unknown argument/);
});

// --- decideLockAction ---

test('decideLockAction: no lock → acquire; live pid → exit; dead pid → takeover', () => {
  assert.deepEqual(decideLockAction(null, () => true), { action: 'acquire' });
  assert.deepEqual(decideLockAction({ pid: 42 }, (pid) => pid === 42), { action: 'exit', pid: 42 });
  assert.deepEqual(decideLockAction({ pid: 42 }, () => false), { action: 'takeover', stalePid: 42 });
  assert.deepEqual(decideLockAction({}, () => true), { action: 'takeover', stalePid: null }, '壊れた lock は takeover');
});

// --- live マーカー（worktree 非依存の実行中判定） ---

test('liveMarkerName: class slug + target number', () => {
  assert.equal(liveMarkerName(CLASS_PLAN, 206), 'live-plan-206.json');
  assert.equal(liveMarkerName(CLASS_IMPLEMENT, 204), 'live-implement-204.json');
  assert.equal(liveMarkerName(CLASS_EXPLAIN, 189), 'live-explain-189.json');
  assert.equal(liveMarkerName(CLASS_PR_REVIEW, 300), 'live-pr-review-300.json');
});

test('parseLiveMarker: validates pid and number; garbage is null (stale)', () => {
  assert.deepEqual(
    parseLiveMarker(JSON.stringify({ pid: 10, kind: 'issue', number: 206 })),
    { pid: 10, kind: 'issue', number: 206 },
  );
  assert.deepEqual(
    parseLiveMarker(JSON.stringify({ pid: 10, kind: 'pr', number: 300 })),
    { pid: 10, kind: 'pr', number: 300 },
  );
  assert.equal(parseLiveMarker('not json'), null);
  assert.equal(parseLiveMarker(JSON.stringify({ pid: 0, kind: 'issue', number: 1 })), null);
  assert.equal(parseLiveMarker(JSON.stringify({ pid: 10, kind: 'issue' })), null);
});

test('deriveRunningTargets: live PIDs are running; dead PIDs are stale — worktree に依存しない', () => {
  const entries = [
    { name: 'live-plan-206.json', marker: { pid: 11, kind: 'issue', number: 206 } }, // plan-task: worktree なし
    { name: 'live-implement-204.json', marker: { pid: 12, kind: 'issue', number: 204 } },
    { name: 'live-pr-review-300.json', marker: { pid: 13, kind: 'pr', number: 300 } },
    { name: 'live-implement-205.json', marker: { pid: 99, kind: 'issue', number: 205 } }, // 死んだ PID
    { name: 'live-broken.json', marker: null },
  ];
  const alive = new Set([11, 12, 13]);
  const running = deriveRunningTargets(entries, (pid) => alive.has(pid));
  assert.deepEqual([...running.issues].sort((a, b) => a - b), [204, 206]);
  assert.deepEqual([...running.prs], [300]);
  assert.deepEqual(running.stale.sort(), ['live-broken.json', 'live-implement-205.json']);
});

// --- dispatch spec ---

test('buildDispatchSpec: PLAN and IMPLEMENT both spawn the driver (run type is label-driven)', () => {
  for (const cls of [CLASS_PLAN, CLASS_IMPLEMENT]) {
    const spec = buildDispatchSpec({ class: cls, number: 206 }, { execPath: '/usr/bin/node' });
    assert.equal(spec.command, '/usr/bin/node');
    assert.deepEqual(spec.args, ['scripts/inner-loop.mjs', '206']);
    assert.equal(spec.logKey, 'issue-206');
  }
});

test('buildDispatchSpec: EXPLAIN uses the SETUP.md §6 canonical claude -p form', () => {
  const spec = buildDispatchSpec({ class: CLASS_EXPLAIN, number: 189 });
  assert.equal(spec.command, 'claude');
  assert.equal(spec.args[0], '-p');
  assert.equal(spec.args[1], buildExplainPrompt(189));
  assert.match(spec.args[1], /issue #189 に対して \.claude\/skills\/explain-diff\/SKILL\.md の解説 loop を実行して/);
  const allowedToolsIdx = spec.args.indexOf('--allowedTools');
  assert.notEqual(allowedToolsIdx, -1, 'must include --allowedTools');
  assert.deepEqual(spec.args.slice(allowedToolsIdx + 1), [...EXPLAIN_ALLOWED_TOOLS]);
  assert.ok(EXPLAIN_ALLOWED_TOOLS.includes('Write(explains/**)'), 'FS 書き込みは explains/ のみ');
  assert.ok(!EXPLAIN_ALLOWED_TOOLS.includes('Bash'), '無制限 Bash は許可しない');
  assert.equal(spec.logKey, 'explain-189');
});

test('buildDispatchSpec: EXPLAIN includes --settings INNER_SETTINGS_PATH', () => {
  const spec = buildDispatchSpec({ class: CLASS_EXPLAIN, number: 189 });
  const idx = spec.args.indexOf('--settings');
  assert.notEqual(idx, -1, 'must include --settings');
  assert.equal(spec.args[idx + 1], INNER_SETTINGS_PATH, '--settings value must be INNER_SETTINGS_PATH');
});

test('buildDispatchSpec: PR_REVIEW spawns the review engine with --pr', () => {
  const spec = buildDispatchSpec({ class: CLASS_PR_REVIEW, number: 300 }, { execPath: '/usr/bin/node' });
  assert.deepEqual(spec.args, ['scripts/review-engine.mjs', '--pr', '300']);
  assert.equal(spec.logKey, 'pr-review-300');
});

test('buildDispatchSpec: non-dispatch classes throw', () => {
  assert.throws(() => buildDispatchSpec({ class: 'WAIT_DEP', number: 1 }), /not a dispatch class/);
});

test('CLASS_SLUGS covers exactly the four dispatch classes', () => {
  assert.deepEqual(
    Object.keys(CLASS_SLUGS).sort(),
    [CLASS_EXPLAIN, CLASS_IMPLEMENT, CLASS_PLAN, CLASS_PR_REVIEW].sort(),
  );
});

// --- outcome / circuit breaker（escalation は故障と数えない） ---

test('classifyChildOutcome: exit 0 → success; non-zero → escalation or failure', () => {
  assert.equal(classifyChildOutcome({ exitCode: 0, escalated: false }), OUTCOME_SUCCESS);
  assert.equal(classifyChildOutcome({ exitCode: 1, escalated: true }), OUTCOME_ESCALATION);
  assert.equal(classifyChildOutcome({ exitCode: 1, escalated: false }), OUTCOME_FAILURE);
});

test('applyBreaker: three consecutive failures open the circuit', () => {
  let state = { consecutiveFailures: 0, open: false };
  state = applyBreaker(state, OUTCOME_FAILURE, 3);
  state = applyBreaker(state, OUTCOME_FAILURE, 3);
  assert.equal(state.open, false);
  state = applyBreaker(state, OUTCOME_FAILURE, 3);
  assert.deepEqual(state, { consecutiveFailures: 3, open: true });
});

test('applyBreaker: escalation is not a failure — count unchanged, never opens', () => {
  let state = { consecutiveFailures: 2, open: false };
  state = applyBreaker(state, OUTCOME_ESCALATION, 3);
  assert.deepEqual(state, { consecutiveFailures: 2, open: false });
  // escalation を挟んでも連続 failure の判定は壊れない
  state = applyBreaker(state, OUTCOME_FAILURE, 3);
  assert.deepEqual(state, { consecutiveFailures: 3, open: true });
});

test('applyBreaker: success resets the consecutive count; maxFailures=0 disables', () => {
  assert.deepEqual(
    applyBreaker({ consecutiveFailures: 2, open: false }, OUTCOME_SUCCESS, 3),
    { consecutiveFailures: 0, open: false },
  );
  let state = { consecutiveFailures: 0, open: false };
  for (let i = 0; i < 10; i += 1) state = applyBreaker(state, OUTCOME_FAILURE, 0);
  assert.equal(state.open, false);
});

// --- pickNextDispatch（Touches 直列化の吸収） ---

test('pickNextDispatch: overlapping Touches are deferred; non-overlapping picked', () => {
  const active = [{ kind: 'issue', number: 1, class: CLASS_IMPLEMENT, issue: { body: 'Touches: scripts/' } }];
  const pending = [
    { kind: 'issue', number: 2, class: CLASS_IMPLEMENT, issue: { body: 'Touches: scripts/inner-loop.mjs' } },
    { kind: 'issue', number: 3, class: CLASS_IMPLEMENT, issue: { body: 'Touches: apps/web/lib' } },
  ];
  assert.equal(pickNextDispatch(pending, active), 1, '#2 は scripts/ と重複 — #3 を先に');
});

test('pickNextDispatch: PR reviews and Touches-less issues never conflict', () => {
  const active = [{ kind: 'issue', number: 1, class: CLASS_IMPLEMENT, issue: { body: 'Touches: scripts/' } }];
  assert.equal(pickNextDispatch([{ kind: 'pr', number: 300, class: CLASS_PR_REVIEW, pr: {} }], active), 0);
  assert.equal(pickNextDispatch([{ kind: 'issue', number: 2, class: CLASS_PLAN, issue: { body: '' } }], active), 0);
});

test('pickNextDispatch: returns -1 when everything conflicts', () => {
  const active = [{ kind: 'issue', number: 1, class: CLASS_IMPLEMENT, issue: { body: 'Touches: .' } }];
  const pending = [{ kind: 'issue', number: 2, class: CLASS_IMPLEMENT, issue: { body: 'Touches: scripts/x.mjs' } }];
  assert.equal(pickNextDispatch(pending, active), -1);
});

// --- runDispatch: fire-and-forget（#256 pass が dispatch 完了を待たないこと） ---

test('runDispatch: spawnFn は await されない — pass は spawn 直後に返る', () => {
  const spawned = [];
  // spawnFn が Promise を返しても runDispatch は await しない（同期で返る）。
  // settled=false のまま result が返れば「await されていない」証明。
  let settled = false;
  const spawnFn = (decision) => {
    spawned.push(decision.number);
    return new Promise((resolve) => { setImmediate(() => { settled = true; resolve(); }); });
  };
  const dispatches = [
    { class: CLASS_IMPLEMENT, number: 1, kind: 'issue', issue: {} },
    { class: CLASS_IMPLEMENT, number: 2, kind: 'issue', issue: {} },
  ];
  const result = runDispatch({ dispatches, max: 5, spawnFn });
  assert.equal(result.dispatched, 2);
  assert.equal(result.deferred, 0);
  assert.equal(settled, false, 'spawnFn の Promise は await されていない（pass は即返却）');
  assert.deepEqual(spawned.sort((a, b) => a - b), [1, 2]);
});

test('runDispatch: 並列上限 max を超えたら残りは DEFER', () => {
  const spawned = [];
  const spawnFn = (d) => { spawned.push(d.number); };
  const dispatches = [
    { class: CLASS_IMPLEMENT, number: 1, kind: 'issue', issue: {} },
    { class: CLASS_IMPLEMENT, number: 2, kind: 'issue', issue: {} },
    { class: CLASS_IMPLEMENT, number: 3, kind: 'issue', issue: {} },
  ];
  const result = runDispatch({ dispatches, max: 2, spawnFn });
  assert.equal(result.dispatched, 2);
  assert.equal(result.deferred, 1);
  assert.equal(spawned.length, 2);
});

test('runDispatch: Touches 衝突は deferred（次パスで再判定）', () => {
  const spawned = [];
  const spawnFn = (d) => { spawned.push(d.number); };
  // #1 と #2 は同じ Touches（scripts/）— 並列 writer を避けるため #2 は defer
  const dispatches = [
    { class: CLASS_IMPLEMENT, number: 1, kind: 'issue', issue: { body: 'Touches: scripts/' } },
    { class: CLASS_IMPLEMENT, number: 2, kind: 'issue', issue: { body: 'Touches: scripts/x.mjs' } },
  ];
  const result = runDispatch({ dispatches, max: 5, spawnFn });
  assert.equal(result.dispatched, 1, '#1 のみ dispatch');
  assert.equal(result.deferred, 1, '#2 は Touches 衝突で defer');
  assert.deepEqual(spawned, [1]);
});
