import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  META_STAGES,
  META_VERDICT_TOKENS,
  META_OK_VERDICTS,
  parseMetaVerdict,
  nextMetaState,
  metaStagePermissions,
  loadProfile,
  buildMetaRunKey,
  nextMetaSerial,
  metaManifestPath,
  buildMetaManifest,
  parseMetaDriverArgs,
  buildScopePrompt,
  buildGroundPrompt,
  buildDiagnosePrompt,
  buildReportPrompt,
  buildMetaStagePrompt,
  runMetaStageWithRetry,
} from './meta-loop.mjs';

// --- parseMetaVerdict ---

test('parseMetaVerdict: SCOPED parses', () => {
  assert.equal(parseMetaVerdict('some text\nVERDICT: SCOPED'), 'SCOPED');
});

test('parseMetaVerdict: all meta tokens parse', () => {
  for (const token of META_VERDICT_TOKENS) {
    assert.equal(parseMetaVerdict(`VERDICT: ${token}`), token, `expected ${token} to parse`);
  }
});

test('parseMetaVerdict: unknown token → null', () => {
  assert.equal(parseMetaVerdict('VERDICT: PLAN_READY'), null);
  assert.equal(parseMetaVerdict('VERDICT: IMPL_DONE'), null);
  assert.equal(parseMetaVerdict('VERDICT: GREEN'), null);
});

test('parseMetaVerdict: missing VERDICT line → null', () => {
  assert.equal(parseMetaVerdict('no verdict here'), null);
});

test('parseMetaVerdict: null/empty → null', () => {
  assert.equal(parseMetaVerdict(null), null);
  assert.equal(parseMetaVerdict(''), null);
});

test('parseMetaVerdict: last VERDICT wins', () => {
  assert.equal(parseMetaVerdict('VERDICT: SCOPED\nmore\nVERDICT: ESCALATE'), 'ESCALATE');
});

// --- nextMetaState ---

test('nextMetaState: SCOPE:SCOPED → GROUND', () => {
  assert.deepEqual(nextMetaState('SCOPE', 'SCOPED'), { next: 'GROUND' });
});

test('nextMetaState: GROUND:GROUNDED → DIAGNOSE', () => {
  assert.deepEqual(nextMetaState('GROUND', 'GROUNDED'), { next: 'DIAGNOSE' });
});

test('nextMetaState: DIAGNOSE:DIAGNOSED → REPORT', () => {
  assert.deepEqual(nextMetaState('DIAGNOSE', 'DIAGNOSED'), { next: 'REPORT' });
});

test('nextMetaState: REPORT:REPORTED → DONE', () => {
  assert.deepEqual(nextMetaState('REPORT', 'REPORTED'), { next: 'DONE' });
});

test('nextMetaState: any stage + ESCALATE → ESCALATE', () => {
  for (const stage of META_STAGES) {
    assert.deepEqual(nextMetaState(stage, 'ESCALATE'), { next: 'ESCALATE' });
  }
});

test('nextMetaState: null verdict → ESCALATE', () => {
  for (const stage of META_STAGES) {
    assert.deepEqual(nextMetaState(stage, null), { next: 'ESCALATE' });
  }
});

test('nextMetaState: wrong verdict for stage → ESCALATE', () => {
  assert.deepEqual(nextMetaState('SCOPE', 'GROUNDED'), { next: 'ESCALATE' });
  assert.deepEqual(nextMetaState('GROUND', 'SCOPED'), { next: 'ESCALATE' });
  assert.deepEqual(nextMetaState('DIAGNOSE', 'REPORTED'), { next: 'ESCALATE' });
});

test('nextMetaState: unknown stage → ESCALATE', () => {
  assert.deepEqual(nextMetaState('MERGE', 'SCOPED'), { next: 'ESCALATE' });
});

// --- metaStagePermissions ---

test('metaStagePermissions: all stages use meta-auditor + dontAsk', () => {
  for (const stage of META_STAGES) {
    const perm = metaStagePermissions(stage);
    assert.equal(perm.agent, 'meta-auditor');
    assert.equal(perm.permissionMode, 'dontAsk');
    assert.ok(Array.isArray(perm.allowedTools));
  }
});

test('metaStagePermissions: no Write/Edit in any stage', () => {
  for (const stage of META_STAGES) {
    const { allowedTools } = metaStagePermissions(stage);
    const hasWrite = allowedTools.some((t) => /^Write|^Edit/.test(t));
    assert.equal(hasWrite, false, `stage ${stage} must not allow Write/Edit`);
  }
});

test('metaStagePermissions: GROUND includes lathe MCP tools', () => {
  const { allowedTools } = metaStagePermissions('GROUND');
  const hasMcp = allowedTools.some((t) => t.startsWith('mcp__lathe__'));
  assert.ok(hasMcp, 'GROUND must include lathe MCP tools');
});

test('metaStagePermissions: SCOPE/DIAGNOSE/REPORT do NOT include MCP tools', () => {
  for (const stage of ['SCOPE', 'DIAGNOSE', 'REPORT']) {
    const { allowedTools } = metaStagePermissions(stage);
    const hasMcp = allowedTools.some((t) => t.startsWith('mcp__lathe__'));
    assert.equal(hasMcp, false, `stage ${stage} must not include MCP tools`);
  }
});

test('metaStagePermissions: unknown stage throws', () => {
  assert.throws(() => metaStagePermissions('MERGE'), /unknown stage/);
});

// --- loadProfile ---

test('loadProfile: loads existing profile', () => {
  const result = loadProfile('run-health');
  assert.equal(result.ok, true);
  assert.equal(result.profile.id, 'run-health');
  assert.ok(Array.isArray(result.profile.questions));
});

test('loadProfile: run-health には粒度超過検知の question が含まれる', () => {
  const result = loadProfile('run-health');
  assert.equal(result.ok, true);
  const questions = result.profile.questions.join('\n');
  assert.ok(questions.includes('粒度超過'), 'run-health questions に「粒度超過」が含まれること');
  assert.ok(questions.includes('run_stages.duration_ms'), 'run-health questions に「run_stages.duration_ms」が含まれること');
});

test('loadProfile: gate-effectiveness profile exists', () => {
  const result = loadProfile('gate-effectiveness');
  assert.equal(result.ok, true);
  assert.equal(result.profile.id, 'gate-effectiveness');
});

test('loadProfile: unknown profile → error', () => {
  const result = loadProfile('nonexistent-profile-xyz');
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('profile not found'));
});

test('loadProfile: empty profileId → error', () => {
  assert.equal(loadProfile('').ok, false);
  assert.equal(loadProfile(null).ok, false);
});

test('loadProfile: custom repoRoot for testing', () => {
  const dir = join(tmpdir(), `meta-loop-test-${process.pid}`);
  mkdirSync(join(dir, 'scripts', 'meta-profiles'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'meta-profiles', 'test-prof.json'),
    JSON.stringify({ id: 'test-prof', version: '1', target: 'test', grounding: [], questions: [], cadence: 'manual' }));
  const result = loadProfile('test-prof', { repoRoot: dir });
  assert.equal(result.ok, true);
  assert.equal(result.profile.id, 'test-prof');
  rmSync(dir, { recursive: true, force: true });
});

// --- buildMetaRunKey ---

test('buildMetaRunKey: formats serial with 3-digit padding', () => {
  assert.equal(buildMetaRunKey('run-health', 1), 'meta-run-health-001');
  assert.equal(buildMetaRunKey('run-health', 42), 'meta-run-health-042');
  assert.equal(buildMetaRunKey('gate-effectiveness', 100), 'meta-gate-effectiveness-100');
});

// --- nextMetaSerial ---

test('nextMetaSerial: returns 1 when .lathe/runs does not exist', () => {
  const dir = join(tmpdir(), `meta-serial-test-${process.pid}`);
  const result = nextMetaSerial('run-health', { repoRoot: dir });
  assert.equal(result, 1);
});

test('nextMetaSerial: returns 1 when no meta manifests exist', () => {
  const dir = join(tmpdir(), `meta-serial-test2-${process.pid}`);
  mkdirSync(join(dir, '.lathe', 'runs'), { recursive: true });
  const result = nextMetaSerial('run-health', { repoRoot: dir });
  assert.equal(result, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('nextMetaSerial: increments past existing manifests', () => {
  const dir = join(tmpdir(), `meta-serial-test3-${process.pid}`);
  mkdirSync(join(dir, '.lathe', 'runs'), { recursive: true });
  writeFileSync(join(dir, '.lathe', 'runs', 'meta-run-health-001.json'), '{}');
  writeFileSync(join(dir, '.lathe', 'runs', 'meta-run-health-003.json'), '{}');
  const result = nextMetaSerial('run-health', { repoRoot: dir });
  assert.equal(result, 4);
  rmSync(dir, { recursive: true, force: true });
});

test('nextMetaSerial: does not count other profiles', () => {
  const dir = join(tmpdir(), `meta-serial-test4-${process.pid}`);
  mkdirSync(join(dir, '.lathe', 'runs'), { recursive: true });
  writeFileSync(join(dir, '.lathe', 'runs', 'meta-gate-effectiveness-005.json'), '{}');
  const result = nextMetaSerial('run-health', { repoRoot: dir });
  assert.equal(result, 1);
  rmSync(dir, { recursive: true, force: true });
});

// --- metaManifestPath ---

test('metaManifestPath: correct path', () => {
  const dir = '/tmp/test-repo';
  const p = metaManifestPath('run-health', 1, { repoRoot: dir });
  assert.equal(p, '/tmp/test-repo/.lathe/runs/meta-run-health-001.json');
});

// --- buildMetaManifest ---

test('buildMetaManifest: has loop_kind=meta', () => {
  const m = buildMetaManifest('run-health', 1, []);
  assert.equal(m.loop_kind, 'meta');
});

test('buildMetaManifest: has correct shape', () => {
  const stages = [{ stage: 'SCOPE', verdict: 'SCOPED' }];
  const m = buildMetaManifest('run-health', 2, stages, { extra_field: 'x' });
  assert.equal(m.profile, 'run-health');
  assert.equal(m.serial, 2);
  assert.equal(m.run_key, 'meta-run-health-002');
  assert.deepEqual(m.stages, stages);
  assert.equal(m.extra_field, 'x');
});

test('buildMetaManifest: stages array preserved', () => {
  const stages = [{ stage: 'SCOPE' }, { stage: 'GROUND' }];
  const m = buildMetaManifest('gate-effectiveness', 5, stages);
  assert.equal(m.stages.length, 2);
});

// --- parseMetaDriverArgs ---

test('parseMetaDriverArgs: --profile required', () => {
  const r = parseMetaDriverArgs([]);
  assert.ok(r.error?.includes('--profile'));
});

test('parseMetaDriverArgs: --profile sets profileId', () => {
  const r = parseMetaDriverArgs(['--profile', 'run-health']);
  assert.equal(r.error, null);
  assert.equal(r.profileId, 'run-health');
});

test('parseMetaDriverArgs: --dry-run flag', () => {
  const r = parseMetaDriverArgs(['--profile', 'run-health', '--dry-run']);
  assert.equal(r.dryRun, true);
  assert.equal(r.error, null);
});

test('parseMetaDriverArgs: --serial sets serial', () => {
  const r = parseMetaDriverArgs(['--profile', 'run-health', '--serial', '5']);
  assert.equal(r.serial, 5);
  assert.equal(r.error, null);
});

test('parseMetaDriverArgs: invalid --serial', () => {
  const r = parseMetaDriverArgs(['--profile', 'run-health', '--serial', '0']);
  assert.ok(r.error?.includes('--serial'));
});

test('parseMetaDriverArgs: --reason sets reason', () => {
  const r = parseMetaDriverArgs(['--profile', 'run-health', '--reason', 'cadence']);
  assert.equal(r.reason, 'cadence');
});

test('parseMetaDriverArgs: unknown arg → error', () => {
  const r = parseMetaDriverArgs(['--profile', 'run-health', '--unknown']);
  assert.ok(r.error?.includes('unknown argument'));
});

// --- Prompt builders ---

const FAKE_PROFILE = {
  id: 'run-health', version: '1', target: 'inner/plan loop の運行',
  grounding: ['mcp:list_runs', 'file:.lathe/runs/*.json'],
  questions: ['escalation の率は?', 'cycle 分布は?'],
  cadence: '10 run ごと', depth_budget: 'suspect 上限 5・fan-out 上限 4',
};

test('buildScopePrompt: contains profile id and VERDICT tokens', () => {
  const prompt = buildScopePrompt(FAKE_PROFILE, { reason: 'manual' });
  assert.ok(prompt.includes('run-health'));
  assert.ok(prompt.includes('VERDICT: SCOPED'));
  assert.ok(prompt.includes('VERDICT: ESCALATE'));
});

test('buildScopePrompt: contains questions', () => {
  const prompt = buildScopePrompt(FAKE_PROFILE);
  assert.ok(prompt.includes('escalation の率は?'));
});

test('buildGroundPrompt: contains fan-out contract mention', () => {
  const prompt = buildGroundPrompt(FAKE_PROFILE, 'audit plan text');
  assert.ok(prompt.includes('fan-out contract'));
  assert.ok(prompt.includes('X1'));
  assert.ok(prompt.includes('PLAN/IMPLEMENT'));
  assert.ok(prompt.includes('VERDICT: GROUNDED'));
});

test('buildGroundPrompt: contains scope result', () => {
  const prompt = buildGroundPrompt(FAKE_PROFILE, 'my audit plan');
  assert.ok(prompt.includes('my audit plan'));
});

test('buildDiagnosePrompt: contains 13-row taxonomy mention', () => {
  const prompt = buildDiagnosePrompt(FAKE_PROFILE, 'evidence bundle');
  assert.ok(prompt.includes('13'));
  assert.ok(prompt.includes('行'));
  assert.ok(prompt.includes('VERDICT: DIAGNOSED'));
  assert.ok(prompt.includes('VERDICT: ESCALATE'));
});

test('buildReportPrompt: contains VERDICT: REPORTED', () => {
  const prompt = buildReportPrompt(FAKE_PROFILE, 'findings', 'meta-run-health-001');
  assert.ok(prompt.includes('VERDICT: REPORTED'));
  assert.ok(prompt.includes('meta-run-health-001'));
});

test('buildMetaStagePrompt: dispatches to correct builder', () => {
  const ctx = { profile: FAKE_PROFILE, reason: 'test', scopeResult: 'scope', groundResult: 'ground', diagnoseResult: 'diag', runKey: 'meta-run-health-001' };
  assert.ok(buildMetaStagePrompt('SCOPE', ctx).includes('VERDICT: SCOPED'));
  assert.ok(buildMetaStagePrompt('GROUND', ctx).includes('VERDICT: GROUNDED'));
  assert.ok(buildMetaStagePrompt('DIAGNOSE', ctx).includes('VERDICT: DIAGNOSED'));
  assert.ok(buildMetaStagePrompt('REPORT', ctx).includes('VERDICT: REPORTED'));
});

test('buildMetaStagePrompt: unknown stage throws', () => {
  assert.throws(() => buildMetaStagePrompt('MERGE', {}), /unknown stage/);
});

// --- runMetaStageWithRetry ---

test('runMetaStageWithRetry: meta VERDICT token SCOPED is recognised', () => {
  const recorded = [];
  const result = runMetaStageWithRetry({
    runAttempt: () => ({ envelope: { result: 'done\nVERDICT: SCOPED', session_id: 's1' } }),
    recordAttempt: (r) => recorded.push(r),
  });
  assert.equal(result.verdict, 'SCOPED');
  assert.equal(result.manifestVerdict, 'SCOPED');
  assert.equal(recorded.length, 1, 'no retry should occur on success');
});

test('runMetaStageWithRetry: all meta ok verdicts are recognised without retry', () => {
  for (const token of Object.values(META_OK_VERDICTS)) {
    const recorded = [];
    const result = runMetaStageWithRetry({
      runAttempt: () => ({ envelope: { result: `VERDICT: ${token}`, session_id: null } }),
      recordAttempt: (r) => recorded.push(r),
    });
    assert.equal(result.verdict, token, `expected ${token}`);
    assert.equal(recorded.length, 1, `no retry expected for ${token}`);
  }
});

test('runMetaStageWithRetry: ESCALATE is recognised', () => {
  const result = runMetaStageWithRetry({
    runAttempt: () => ({ envelope: { result: 'VERDICT: ESCALATE' } }),
    recordAttempt: () => {},
  });
  assert.equal(result.verdict, 'ESCALATE');
});

test('runMetaStageWithRetry: inner-loop token PLAN_READY is NOT recognised → null verdict', () => {
  let attempts = 0;
  let retries = 0;
  const result = runMetaStageWithRetry({
    runAttempt: () => { attempts += 1; return { envelope: { result: 'VERDICT: PLAN_READY' } }; },
    recordAttempt: () => {},
    onRetry: () => { retries += 1; },
  });
  assert.equal(result.verdict, null, 'inner-loop PLAN_READY must not be accepted as meta verdict');
  assert.equal(result.manifestVerdict, 'UNPARSABLE');
  assert.equal(attempts, 2, 'should have tried once + one retry');
  assert.equal(retries, 1);
});

test('runMetaStageWithRetry: inner-loop tokens GREEN/IMPL_DONE are NOT recognised', () => {
  for (const token of ['GREEN', 'IMPL_DONE', 'PASS', 'CHANGES', 'RED', 'KNOWN', 'NOVEL']) {
    const result = runMetaStageWithRetry({
      runAttempt: () => ({ envelope: { result: `VERDICT: ${token}` } }),
      recordAttempt: () => {},
      onRetry: () => {},
    });
    assert.equal(result.verdict, null, `inner-loop token ${token} must not be accepted`);
  }
});

test('runMetaStageWithRetry: retries once then returns null when always UNPARSABLE', () => {
  let attempts = 0;
  const result = runMetaStageWithRetry({
    runAttempt: () => { attempts += 1; return { envelope: { result: 'no verdict here' } }; },
    recordAttempt: () => {},
  });
  assert.equal(result.verdict, null);
  assert.equal(attempts, 2, 'default maxRetries=1 means 2 total attempts');
});

test('runMetaStageWithRetry: success on retry is returned correctly', () => {
  let attempts = 0;
  const result = runMetaStageWithRetry({
    runAttempt: () => {
      attempts += 1;
      const txt = attempts === 1 ? 'no verdict' : 'VERDICT: GROUNDED';
      return { envelope: { result: txt } };
    },
    recordAttempt: () => {},
  });
  assert.equal(result.verdict, 'GROUNDED');
  assert.equal(attempts, 2);
});

test('runMetaStageWithRetry: throws if runAttempt missing', () => {
  assert.throws(() => runMetaStageWithRetry({ recordAttempt: () => {} }), /runAttempt is required/);
});

test('runMetaStageWithRetry: throws if recordAttempt missing', () => {
  assert.throws(() => runMetaStageWithRetry({ runAttempt: () => ({ envelope: {} }) }), /recordAttempt is required/);
});

// --- META_STAGES / META_OK_VERDICTS constants ---

test('META_STAGES has 4 stages in order', () => {
  assert.deepEqual(META_STAGES, ['SCOPE', 'GROUND', 'DIAGNOSE', 'REPORT']);
});

test('META_OK_VERDICTS maps all 4 stages', () => {
  for (const stage of META_STAGES) {
    assert.ok(META_OK_VERDICTS[stage], `META_OK_VERDICTS must have entry for ${stage}`);
  }
});

test('META_VERDICT_TOKENS includes ESCALATE and all ok verdicts', () => {
  assert.ok(META_VERDICT_TOKENS.includes('ESCALATE'));
  for (const v of Object.values(META_OK_VERDICTS)) {
    assert.ok(META_VERDICT_TOKENS.includes(v), `META_VERDICT_TOKENS must include ${v}`);
  }
});

// --- Dry-run CLI integration ---

test('meta-loop --dry-run with valid profile exits 0 and shows transition plan', () => {
  const r = spawnSync('node', ['scripts/meta-loop.mjs', '--profile', 'run-health', '--dry-run'], {
    encoding: 'utf8',
    cwd: join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..'),
  });
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes('SCOPE'), 'dry-run output must mention SCOPE');
  assert.ok(r.stdout.includes('GROUND'), 'dry-run output must mention GROUND');
  assert.ok(r.stdout.includes('DIAGNOSE'), 'dry-run output must mention DIAGNOSE');
  assert.ok(r.stdout.includes('REPORT'), 'dry-run output must mention REPORT');
  assert.ok(r.stdout.includes('transition plan'), 'dry-run output must show transition plan');
});

test('meta-loop missing --profile exits nonzero', () => {
  const r = spawnSync('node', ['scripts/meta-loop.mjs', '--dry-run'], {
    encoding: 'utf8',
    cwd: join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..'),
  });
  assert.notEqual(r.status, 0, 'must exit nonzero without --profile');
});
