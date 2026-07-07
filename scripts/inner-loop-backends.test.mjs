import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import {
  stagePermissions,
  stageSandbox,
  buildCodexArgs,
  buildClaudeArgs,
  stripFrontmatter,
  buildCodexPrompt,
  parseCodexSessionId,
  parseBackendFlags,
  selectBackend,
  detectMainDirty,
  INNER_SETTINGS_PATH,
} from './inner-loop-backends.mjs';

// --- stagePermissions: only PLAN (plan-task) and IMPLEMENT remain (#116) ---
//
// IMPLEMENT keeps blanket Bash (issues #36/#44/#45): verification/commit
// idioms compose arbitrary commands and structurally conflict with
// fine-grained allowlists. Containment is worktree cwd, the role contract,
// the main-dirty backstop, and the PR+CI landing gate — not the allowlist.

test('stagePermissions: PLAN stays narrow and read-only (planner, gh issue reads only)', () => {
  const { agent, permissionMode, allowedTools } = stagePermissions('PLAN');
  assert.equal(agent, 'planner');
  assert.equal(permissionMode, 'dontAsk');
  assert.ok(!allowedTools.includes('Bash'), 'must not grant blanket Bash');
  assert.ok(allowedTools.includes('Bash(git *)'));
  assert.ok(allowedTools.includes('Bash(gh issue view *)'));
  assert.ok(allowedTools.includes('Bash(gh issue list *)'));
  assert.ok(!allowedTools.includes('Bash(gh issue *)'), 'must not allow gh issue writes');
});

test('stagePermissions: IMPLEMENT grants blanket Bash through worktree containment', () => {
  const { agent, permissionMode, allowedTools } = stagePermissions('IMPLEMENT');
  assert.equal(agent, 'implementer');
  assert.equal(permissionMode, 'acceptEdits');
  assert.deepEqual(allowedTools, ['Read', 'Grep', 'Glob', 'Bash']);
});

test('stagePermissions: no stage uses bypassPermissions or --bare', () => {
  for (const stage of ['PLAN', 'IMPLEMENT']) {
    const { permissionMode } = stagePermissions(stage);
    assert.notEqual(permissionMode, 'bypassPermissions');
    assert.notEqual(permissionMode, '--bare');
  }
});

test('stagePermissions: removed stages throw (REVIEW/VERIFY/TRIAGE/RESEARCH)', () => {
  for (const stage of ['REVIEW', 'VERIFY', 'TRIAGE', 'RESEARCH']) {
    assert.throws(() => stagePermissions(stage), new RegExp(`unknown stage "${stage}"`));
  }
});

// --- stageSandbox ---

test('stageSandbox: IMPLEMENT -> workspace-write', () => {
  assert.equal(stageSandbox('IMPLEMENT'), 'workspace-write');
});

test('stageSandbox: PLAN -> read-only', () => {
  assert.equal(stageSandbox('PLAN'), 'read-only');
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

test('buildCodexArgs: workspace-write stage enables sandbox localhost/network access', () => {
  const args = buildCodexArgs('IMPLEMENT', 'p', '/wt', '/tmp/out.txt');
  assert.ok(args.includes('-c'), 'must include config override');
  assert.ok(args.includes('sandbox_workspace_write.network_access=true'), 'must enable network access');
});

test('buildCodexArgs: read-only stage does not enable workspace-write network config', () => {
  const args = buildCodexArgs('PLAN', 'p', '/repo', '/tmp/out.txt');
  assert.ok(!args.includes('sandbox_workspace_write.network_access=true'), 'must not add workspace-write config');
});

test('buildCodexArgs: prompt is first element', () => {
  const args = buildCodexArgs('PLAN', 'my prompt', '/repo', '/tmp/out.txt');
  assert.equal(args[0], 'my prompt');
});

test('buildCodexArgs: never includes --dangerously-bypass or --ephemeral (regression guard)', () => {
  for (const stage of ['PLAN', 'IMPLEMENT']) {
    const args = buildCodexArgs(stage, 'p', '/cwd', '/tmp/out.txt');
    for (const a of args) {
      assert.ok(!String(a).includes('dangerously'), `stage=${stage}: must never include --dangerously-bypass-*`);
    }
    assert.ok(!args.includes('--ephemeral'), `stage=${stage}: must not include --ephemeral`);
  }
});

test('buildCodexArgs: optional model flag (-m) is appended when provided', () => {
  const args = buildCodexArgs('PLAN', 'p', '/repo', '/tmp/out.txt', undefined, 'gpt-5.4');
  assert.ok(args.includes('-m'));
  assert.ok(args.includes('gpt-5.4'));
});

test('buildCodexArgs: no -m when model is undefined', () => {
  const args = buildCodexArgs('PLAN', 'p', '/repo', '/tmp/out.txt');
  assert.ok(!args.includes('-m'));
});

// --- buildCodexArgs: --add-dir <repoRoot>/.git (worktree git-dir writability) ---

test('buildCodexArgs: workspace-write stage with repoRoot adds --add-dir <repoRoot>/.git', () => {
  const args = buildCodexArgs('IMPLEMENT', 'p', '/wt', '/tmp/out.txt', '/repo');
  assert.ok(args.includes('--add-dir'), 'must include --add-dir');
  assert.ok(args.includes('/repo/.git'), 'must grant <repoRoot>/.git');
});

test('buildCodexArgs: read-only stage does not add --add-dir even when repoRoot is provided', () => {
  const args = buildCodexArgs('PLAN', 'p', '/repo', '/tmp/out.txt', '/repo');
  assert.ok(!args.includes('--add-dir'), 'must not include --add-dir');
});

test('buildCodexArgs: workspace-write stage without repoRoot omits --add-dir', () => {
  const args = buildCodexArgs('IMPLEMENT', 'p', '/wt', '/tmp/out.txt');
  assert.ok(!args.includes('--add-dir'));
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

test('buildClaudeArgs: IMPLEMENT passes blanket Bash allowedTools', () => {
  const args = buildClaudeArgs('IMPLEMENT', 'p', null);
  const allowedToolsIndex = args.indexOf('--allowedTools');
  assert.notEqual(allowedToolsIndex, -1);
  assert.equal(args[allowedToolsIndex + 1], 'Read,Grep,Glob,Bash');
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

// --- INNER_SETTINGS_PATH ---

test('INNER_SETTINGS_PATH: is an absolute path ending in .claude/settings.json', () => {
  assert.ok(isAbsolute(INNER_SETTINGS_PATH), 'must be absolute');
  assert.ok(
    INNER_SETTINGS_PATH.endsWith('/.claude/settings.json') ||
    INNER_SETTINGS_PATH.endsWith('\\.claude\\settings.json'),
    `expected path ending in /.claude/settings.json, got: ${INNER_SETTINGS_PATH}`,
  );
});

test('buildClaudeArgs: includes --settings INNER_SETTINGS_PATH in every stage', () => {
  for (const stage of ['PLAN', 'IMPLEMENT', 'TASK_PLAN', 'PLAN_REVIEW']) {
    const args = buildClaudeArgs(stage, 'p', null);
    const idx = args.indexOf('--settings');
    assert.notEqual(idx, -1, `stage=${stage}: must include --settings`);
    assert.equal(args[idx + 1], INNER_SETTINGS_PATH, `stage=${stage}: --settings value must be INNER_SETTINGS_PATH`);
  }
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

test('parseCodexSessionId: extracts id from observed codex exec rollout session_meta payload', () => {
  const jsonl = [
    JSON.stringify({
      timestamp: '2026-06-25T04:36:41.478Z',
      type: 'session_meta',
      payload: {
        session_id: '019efd10-dc20-7171-ad13-bf81c5e1862b',
        id: '019efd10-dc20-7171-ad13-bf81c5e1862b',
        cwd: '/Users/cherie/LLMWiki/projects/lathe-ds-wt',
        originator: 'codex_exec',
        cli_version: '0.142.1',
        source: 'exec',
      },
    }),
  ].join('\n');
  assert.equal(parseCodexSessionId(jsonl), '019efd10-dc20-7171-ad13-bf81c5e1862b');
});

test('parseCodexSessionId: extracts session_id from codex exec session_configured event', () => {
  const jsonl = [
    JSON.stringify({ type: 'turn_started', turn_id: 'turn-1' }),
    JSON.stringify({ type: 'session_configured', session_id: 'exec-session-123', model_provider_id: 'openai' }),
  ].join('\n');
  assert.equal(parseCodexSessionId(jsonl), 'exec-session-123');
});

test('parseCodexSessionId: extracts thread_id from observed codex exec thread.started event', () => {
  const jsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: '019f223b-2f0d-7b92-ad3c-22f5212021c8' }),
    JSON.stringify({ type: 'turn.started' }),
  ].join('\n');
  assert.equal(parseCodexSessionId(jsonl), '019f223b-2f0d-7b92-ad3c-22f5212021c8');
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

// parseCodexCostUsd / parseCodexCostReport tests live in
// inner-loop-backends-cost.test.mjs (file-size guard split, #116).

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
  const flags = parseBackendFlags(['--backend-implement', 'claude']);
  assert.ok('IMPLEMENT' in flags.stages);
  assert.ok(!('implement' in flags.stages));
});

test('parseBackendFlags: hyphenated stage key maps to underscore stage name', () => {
  const flags = parseBackendFlags(['--backend-some-stage', 'claude']);
  assert.equal(flags.stages.SOME_STAGE, 'claude');
});

// --- selectBackend ---

test('selectBackend: default is claude for all stages when no flags', () => {
  assert.equal(selectBackend('PLAN', { global: null, stages: {} }), 'claude');
  assert.equal(selectBackend('IMPLEMENT', { global: null, stages: {} }), 'claude');
});

test('selectBackend: global override applies to all stages', () => {
  const flags = { global: 'claude', stages: {} };
  for (const s of ['PLAN', 'IMPLEMENT']) {
    assert.equal(selectBackend(s, flags), 'claude', `stage=${s}`);
  }
});

test('selectBackend: stage override takes precedence over global', () => {
  const flags = { global: 'codex', stages: { PLAN: 'claude' } };
  assert.equal(selectBackend('PLAN', flags), 'claude');
  assert.equal(selectBackend('IMPLEMENT', flags), 'codex');
});

test('selectBackend: stage not in stages and no global -> claude default', () => {
  const flags = { global: null, stages: { PLAN: 'claude' } };
  assert.equal(selectBackend('IMPLEMENT', flags), 'claude');
});

// --- buildCodexArgs: absolute cwd guard (issue #39) ---

test('buildCodexArgs: throws when cwd is a relative path', () => {
  assert.throws(
    () => buildCodexArgs('PLAN', 'prompt', 'relative/path', '/tmp/out.txt'),
    /cwd must be an absolute path/,
  );
});

test('buildCodexArgs: throws when cwd is bare filename (no slash)', () => {
  assert.throws(
    () => buildCodexArgs('IMPLEMENT', 'prompt', 'worktree', '/tmp/out.txt'),
    /cwd must be an absolute path/,
  );
});

test('buildCodexArgs: accepts absolute cwd without throwing', () => {
  assert.doesNotThrow(() => buildCodexArgs('PLAN', 'prompt', '/absolute/path', '/tmp/out.txt'));
  assert.doesNotThrow(() => buildCodexArgs('IMPLEMENT', 'prompt', '/wt/path', '/tmp/out.txt'));
});

// --- detectMainDirty (issue #39 backstop) ---

test('detectMainDirty: empty string -> dirty=false', () => {
  assert.deepEqual(detectMainDirty(''), { dirty: false, paths: [] });
});

test('detectMainDirty: null/undefined -> dirty=false', () => {
  assert.deepEqual(detectMainDirty(null), { dirty: false, paths: [] });
  assert.deepEqual(detectMainDirty(undefined), { dirty: false, paths: [] });
});

test('detectMainDirty: untracked only (??) -> dirty=false, no paths', () => {
  const text = '?? node_modules/\n?? dist/\n?? .next/\n';
  const result = detectMainDirty(text);
  assert.equal(result.dirty, false);
  assert.deepEqual(result.paths, []);
});

test('detectMainDirty: modified tracked file -> dirty=true with path', () => {
  const text = 'M  apps/web/scripts/ingest/usecase/incremental.ts\n';
  const result = detectMainDirty(text);
  assert.equal(result.dirty, true);
  assert.deepEqual(result.paths, ['apps/web/scripts/ingest/usecase/incremental.ts']);
});

test('detectMainDirty: multiple tracked changes -> all paths returned', () => {
  const text = [
    'M  apps/web/scripts/ingest/usecase/incremental.ts',
    ' M apps/web/scripts/ingest/usecase/incremental.test.ts',
    'M  apps/web/scripts/verify-incremental-ingest.ts',
  ].join('\n') + '\n';
  const result = detectMainDirty(text);
  assert.equal(result.dirty, true);
  assert.equal(result.paths.length, 3);
});

test('detectMainDirty: mix of tracked and untracked -> only tracked in paths', () => {
  const text = 'M  tracked.ts\n?? untracked.ts\n D deleted.ts\n';
  const result = detectMainDirty(text);
  assert.equal(result.dirty, true);
  // untracked must be excluded, tracked and deleted must appear
  assert.ok(result.paths.includes('tracked.ts'));
  assert.ok(result.paths.includes('deleted.ts'));
  assert.ok(!result.paths.includes('untracked.ts'));
});

test('detectMainDirty: deleted tracked file -> dirty=true', () => {
  const text = ' D apps/web/lib/foo.ts\n';
  const result = detectMainDirty(text);
  assert.equal(result.dirty, true);
  assert.equal(result.paths.length, 1);
});

test('detectMainDirty: whitespace-only lines are ignored', () => {
  const text = '\n  \nM  file.ts\n\n';
  const result = detectMainDirty(text);
  assert.equal(result.dirty, true);
  assert.deepEqual(result.paths, ['file.ts']);
});

// parseDependsOnLine (plan-loop Depends-on machinery) was removed with the
// plan-loop (#116); its successor parseBlockedByLine is covered in
// inner-loop-plan-task.test.mjs.
