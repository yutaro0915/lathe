import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePreflightArgs, runPreflight } from './preflight.mjs';

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (chunk) => { stdout += String(chunk); } },
    stderr: { write: (chunk) => { stderr += String(chunk); } },
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

test('parsePreflightArgs: accepts --changed paths with tier flags', () => {
  const parsed = parsePreflightArgs(['--fast', '--changed', 'scripts/inner-loop.mjs', 'scripts/preflight.mjs']);
  assert.deepEqual(parsed, {
    mode: 'fast',
    changedSpecified: true,
    changed: ['scripts/inner-loop.mjs', 'scripts/preflight.mjs'],
    warnings: [],
    error: null,
  });
});

test('runPreflight: --changed uses specified paths and skips porcelain detection', () => {
  const io = captureIo();
  let getStatusCalled = false;
  let rubricsArgs = null;

  const exitCode = runPreflight(['--fast', '--changed', 'scripts/inner-loop.mjs'], {
    getStatus: () => {
      getStatusCalled = true;
      return '?? preflight-out.txt\n';
    },
    runRubrics: (args) => {
      rubricsArgs = args;
      return { status: 0 };
    },
    stdout: io.stdout,
    stderr: io.stderr,
  });

  assert.equal(exitCode, 0);
  assert.equal(getStatusCalled, false);
  assert.deepEqual(rubricsArgs, ['rubrics/run.mjs', '--changed', 'scripts/inner-loop.mjs', '--tier', 'test']);
  assert.match(io.stdoutText(), /\[preflight:fast\] tier=test changed=1/);
  assert.equal(io.stderrText(), '');
});

test('runPreflight: unknown flags warn instead of becoming silent no-ops', () => {
  const io = captureIo();
  const exitCode = runPreflight(['--bogus', '--changed', 'scripts/preflight.mjs'], {
    getStatus: () => {
      throw new Error('getStatus should not be called when --changed is specified');
    },
    runRubrics: () => ({ status: 0 }),
    stdout: io.stdout,
    stderr: io.stderr,
  });

  assert.equal(exitCode, 0);
  assert.match(io.stderrText(), /\[preflight\] warning: unknown flag --bogus/);
});

test('runPreflight: --changed without paths exits with usage error', () => {
  const io = captureIo();
  const exitCode = runPreflight(['--changed'], {
    getStatus: () => {
      throw new Error('getStatus should not be called for usage errors');
    },
    runRubrics: () => {
      throw new Error('runRubrics should not be called for usage errors');
    },
    stdout: io.stdout,
    stderr: io.stderr,
  });

  assert.equal(exitCode, 2);
  assert.match(io.stderrText(), /--changed requires at least one path/);
});

test('runPreflight: returns child rubric exit status', () => {
  const io = captureIo();
  const exitCode = runPreflight(['--changed', 'scripts/preflight.mjs'], {
    getStatus: () => {
      throw new Error('getStatus should not be called when --changed is specified');
    },
    runRubrics: () => ({ status: 7 }),
    stdout: io.stdout,
    stderr: io.stderr,
  });

  assert.equal(exitCode, 7);
});

test('runPreflight: without --changed keeps porcelain-derived filtering behavior', () => {
  const io = captureIo();
  let rubricsArgs = null;

  const exitCode = runPreflight(['--quick'], {
    getStatus: () => [
      ' M scripts/preflight.mjs',
      '?? .agents/local.json',
      '?? skills-lock.json',
      '',
    ].join('\n'),
    runRubrics: (args) => {
      rubricsArgs = args;
      return { status: 0 };
    },
    stdout: io.stdout,
    stderr: io.stderr,
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(rubricsArgs, ['rubrics/run.mjs', '--changed', 'scripts/preflight.mjs', '--tier', 'cmd']);
});
