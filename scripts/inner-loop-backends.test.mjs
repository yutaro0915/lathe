import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stageSandbox,
  buildCodexArgs,
  buildClaudeArgs,
  stripFrontmatter,
  buildCodexPrompt,
  parseCodexSessionId,
  parseBackendFlags,
  selectBackend,
} from './inner-loop-backends.mjs';

// --- stageSandbox ---

test('stageSandbox: IMPLEMENT -> workspace-write', () => {
  assert.equal(stageSandbox('IMPLEMENT'), 'workspace-write');
});

test('stageSandbox: PLAN -> read-only', () => {
  assert.equal(stageSandbox('PLAN'), 'read-only');
});

test('stageSandbox: REVIEW -> read-only', () => {
  assert.equal(stageSandbox('REVIEW'), 'read-only');
});

test('stageSandbox: VERIFY -> read-only', () => {
  assert.equal(stageSandbox('VERIFY'), 'read-only');
});

test('stageSandbox: TRIAGE -> read-only', () => {
  assert.equal(stageSandbox('TRIAGE'), 'read-only');
});

// --- buildCodexArgs ---

test('buildCodexArgs: includes --json, -o, -C, -s flags', () => {
  const args = buildCodexArgs('PLAN', 'do the thing', '/repo', '/tmp/out.txt');
  assert.ok(args.includes('--json'), 'must include --json');
  assert.ok(args.includes('-o'), 'must include -o');
  assert.ok(args.includes('/tmp/out.txt'), 'must include lastmsgPath');
  assert.ok(args.includes('-C'), 'must include -C');
  assert.ok(args.includes('/repo'), 'must include cwd');
  assert.ok(args.includes('-s'), 'must include -s');
  assert.ok(args.includes('read-only'), 'PLAN must use read-only');
});

test('buildCodexArgs: IMPLEMENT uses workspace-write sandbox', () => {
  const args = buildCodexArgs('IMPLEMENT', 'implement it', '/wt', '/tmp/out.txt');
  assert.ok(args.includes('workspace-write'));
  assert.ok(!args.includes('read-only'));
});

test('buildCodexArgs: prompt is first element', () => {
  const args = buildCodexArgs('PLAN', 'my prompt', '/repo', '/tmp/out.txt');
  assert.equal(args[0], 'my prompt');
});

test('buildCodexArgs: never includes --dangerously-bypass (regression guard)', () => {
  for (const stage of ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    const args = buildCodexArgs(stage, 'p', '/cwd', '/tmp/out.txt');
    for (const a of args) {
      assert.ok(!String(a).includes('dangerously'), `stage=${stage}: must never include --dangerously-bypass-*`);
    }
  }
});

test('buildCodexArgs: never includes --ephemeral (regression guard)', () => {
  for (const stage of ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    const args = buildCodexArgs(stage, 'p', '/cwd', '/tmp/out.txt');
    assert.ok(!args.includes('--ephemeral'), `stage=${stage}: must not include --ephemeral`);
  }
});

test('buildCodexArgs: optional model flag (-m) is appended when provided', () => {
  const args = buildCodexArgs('PLAN', 'p', '/repo', '/tmp/out.txt', 'gpt-5.4');
  assert.ok(args.includes('-m'));
  assert.ok(args.includes('gpt-5.4'));
});

test('buildCodexArgs: no -m when model is undefined', () => {
  const args = buildCodexArgs('PLAN', 'p', '/repo', '/tmp/out.txt');
  assert.ok(!args.includes('-m'));
});

// --- buildClaudeArgs ---

test('buildClaudeArgs: PLAN builds correct -p/--agent/--output-format/--permission-mode argv', () => {
  const args = buildClaudeArgs('PLAN', 'the prompt', null);
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('the prompt'));
  assert.ok(args.includes('--agent'));
  assert.ok(args.includes('planner'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('json'));
  assert.ok(args.includes('--permission-mode'));
  assert.ok(args.includes('dontAsk'));
});

test('buildClaudeArgs: IMPLEMENT uses acceptEdits', () => {
  const args = buildClaudeArgs('IMPLEMENT', 'p', null);
  assert.ok(args.includes('acceptEdits'));
  assert.ok(args.includes('implementer'));
});

test('buildClaudeArgs: includes --resume when resumeSessionId is provided', () => {
  const args = buildClaudeArgs('PLAN', 'p', 'sess-abc');
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('sess-abc'));
});

test('buildClaudeArgs: no --resume when resumeSessionId is null', () => {
  const args = buildClaudeArgs('PLAN', 'p', null);
  assert.ok(!args.includes('--resume'));
});

// --- stripFrontmatter ---

test('stripFrontmatter: removes standard frontmatter block', () => {
  const input = '---\nname: planner\nmodel: sonnet\n---\nBody text here.';
  const result = stripFrontmatter(input);
  assert.equal(result, 'Body text here.');
});

test('stripFrontmatter: no frontmatter returns input unchanged', () => {
  const input = 'Just body text, no frontmatter.';
  assert.equal(stripFrontmatter(input), input);
});

test('stripFrontmatter: empty string returns empty string', () => {
  assert.equal(stripFrontmatter(''), '');
});

test('stripFrontmatter: null/undefined returns empty string', () => {
  assert.equal(stripFrontmatter(null), '');
  assert.equal(stripFrontmatter(undefined), '');
});

test('stripFrontmatter: multiline frontmatter values are removed', () => {
  const input = '---\nname: foo\ndescription: a long\n  description\n---\nActual body.';
  assert.equal(stripFrontmatter(input), 'Actual body.');
});

// --- buildCodexPrompt ---

test('buildCodexPrompt: role body appears before stage prompt', () => {
  const result = buildCodexPrompt('You are a planner.', 'Plan issue #5.');
  assert.match(result, /You are a planner/);
  assert.match(result, /Plan issue #5/);
  const bodyIdx = result.indexOf('You are a planner');
  const promptIdx = result.indexOf('Plan issue #5');
  assert.ok(bodyIdx < promptIdx, 'agent body must come before stage prompt');
});

test('buildCodexPrompt: empty agentBody returns stagePrompt unchanged', () => {
  assert.equal(buildCodexPrompt('', 'Plan issue #5.'), 'Plan issue #5.');
});

test('buildCodexPrompt: null-ish agentBody returns stagePrompt', () => {
  assert.equal(buildCodexPrompt(null, 'Plan issue #5.'), 'Plan issue #5.');
  assert.equal(buildCodexPrompt(undefined, 'Plan issue #5.'), 'Plan issue #5.');
});

// --- parseCodexSessionId ---

test('parseCodexSessionId: extracts id from session_meta payload', () => {
  const jsonl = [
    JSON.stringify({ type: 'session_meta', timestamp: '2026-07-02T00:00:00Z', payload: { id: 'rollout-abc123', cwd: '/repo' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } }),
  ].join('\n');
  assert.equal(parseCodexSessionId(jsonl), 'rollout-abc123');
});

test('parseCodexSessionId: returns null when no session_meta', () => {
  const jsonl = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'go' } });
  assert.equal(parseCodexSessionId(jsonl), null);
});

test('parseCodexSessionId: skips malformed lines, finds valid one', () => {
  const jsonl = [
    'not-json',
    JSON.stringify({ type: 'session_meta', payload: { id: 'sess-xyz' } }),
  ].join('\n');
  assert.equal(parseCodexSessionId(jsonl), 'sess-xyz');
});

test('parseCodexSessionId: returns null for empty/null/undefined input', () => {
  assert.equal(parseCodexSessionId(''), null);
  assert.equal(parseCodexSessionId(null), null);
  assert.equal(parseCodexSessionId(undefined), null);
});

test('parseCodexSessionId: session_meta without payload.id -> null', () => {
  const jsonl = JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo' } });
  assert.equal(parseCodexSessionId(jsonl), null);
});

// --- parseBackendFlags ---

test('parseBackendFlags: --backend claude sets global', () => {
  const flags = parseBackendFlags(['35', '--dry-run', '--backend', 'claude']);
  assert.equal(flags.global, 'claude');
  assert.deepEqual(flags.stages, {});
});

test('parseBackendFlags: --backend-plan claude sets stage override', () => {
  const flags = parseBackendFlags(['--backend-plan', 'claude']);
  assert.equal(flags.global, null);
  assert.equal(flags.stages.PLAN, 'claude');
});

test('parseBackendFlags: mixed global + stage override', () => {
  const flags = parseBackendFlags(['--backend', 'codex', '--backend-implement', 'claude']);
  assert.equal(flags.global, 'codex');
  assert.equal(flags.stages.IMPLEMENT, 'claude');
});

test('parseBackendFlags: no backend flags -> null global, empty stages', () => {
  const flags = parseBackendFlags(['35', '--dry-run']);
  assert.equal(flags.global, null);
  assert.deepEqual(flags.stages, {});
});

test('parseBackendFlags: stage key is uppercased', () => {
  const flags = parseBackendFlags(['--backend-verify', 'claude']);
  assert.ok('VERIFY' in flags.stages);
  assert.ok(!('verify' in flags.stages));
});

// --- selectBackend ---

test('selectBackend: default is codex when no flags', () => {
  assert.equal(selectBackend('PLAN', { global: null, stages: {} }), 'codex');
  assert.equal(selectBackend('IMPLEMENT', { global: null, stages: {} }), 'codex');
});

test('selectBackend: global override applies to all stages', () => {
  const flags = { global: 'claude', stages: {} };
  for (const s of ['PLAN', 'IMPLEMENT', 'REVIEW', 'VERIFY', 'TRIAGE']) {
    assert.equal(selectBackend(s, flags), 'claude', `stage=${s}`);
  }
});

test('selectBackend: stage override takes precedence over global', () => {
  const flags = { global: 'codex', stages: { PLAN: 'claude' } };
  assert.equal(selectBackend('PLAN', flags), 'claude');
  assert.equal(selectBackend('IMPLEMENT', flags), 'codex');
});

test('selectBackend: stage not in stages.stages falls back to global', () => {
  const flags = { global: 'claude', stages: { PLAN: 'claude' } };
  assert.equal(selectBackend('REVIEW', flags), 'claude');
});

test('selectBackend: stage not in stages and no global -> codex', () => {
  const flags = { global: null, stages: { PLAN: 'claude' } };
  assert.equal(selectBackend('REVIEW', flags), 'codex');
});
