/**
 * Unit tests for exit-disposition classifier.
 * No DB, no I/O. Runs via `node --import tsx --test`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyExit } from './exit-disposition';
import type { ExitEvent } from './exit-disposition';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function ev(overrides: Partial<ExitEvent>): ExitEvent {
  return {
    type: 'bash',
    command: null,
    exit_code: null,
    title: null,
    body: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Rule 1: 'na' — no exit code, not an error event
// ---------------------------------------------------------------------------

describe("Rule 1 — 'na'", () => {
  it('thinking event with null exit → na', () => {
    assert.strictEqual(classifyExit(ev({ type: 'thinking', exit_code: null })), 'na');
  });

  it('user_message with null exit → na', () => {
    assert.strictEqual(classifyExit(ev({ type: 'user_message', exit_code: null })), 'na');
  });

  it('assistant_message with null exit → na', () => {
    assert.strictEqual(classifyExit(ev({ type: 'assistant_message', exit_code: null })), 'na');
  });

  it('file_edit with null exit → na', () => {
    assert.strictEqual(classifyExit(ev({ type: 'file_edit', exit_code: null })), 'na');
  });

  it('subagent with null exit → na', () => {
    assert.strictEqual(classifyExit(ev({ type: 'subagent', exit_code: null })), 'na');
  });
});

// ---------------------------------------------------------------------------
// Rule 2: 'failure' — type === 'error' regardless of exit_code
// ---------------------------------------------------------------------------

describe("Rule 2 — 'failure' for type=error", () => {
  it('type=error with null exit → failure', () => {
    assert.strictEqual(classifyExit(ev({ type: 'error', exit_code: null })), 'failure');
  });

  it('type=error with exit 0 → failure (error type wins)', () => {
    assert.strictEqual(classifyExit(ev({ type: 'error', exit_code: 0 })), 'failure');
  });

  it('type=error with exit 1 → failure', () => {
    assert.strictEqual(classifyExit(ev({ type: 'error', exit_code: 1 })), 'failure');
  });

  it('type=error with exit 127 → failure', () => {
    assert.strictEqual(classifyExit(ev({ type: 'error', exit_code: 127 })), 'failure');
  });
});

// ---------------------------------------------------------------------------
// Rule 3: 'ok' — exit 0
// ---------------------------------------------------------------------------

describe("Rule 3 — 'ok'", () => {
  it('bash exit 0 → ok', () => {
    assert.strictEqual(classifyExit(ev({ type: 'bash', exit_code: 0, command: 'ls -la' })), 'ok');
  });

  it('test exit 0 → ok', () => {
    assert.strictEqual(classifyExit(ev({ type: 'test', exit_code: 0, command: 'pnpm test' })), 'ok');
  });

  it('commit exit 0 → ok', () => {
    assert.strictEqual(
      classifyExit(ev({ type: 'commit', exit_code: 0, command: 'git commit -m "fix"' })),
      'ok',
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 4a: 'gate_verdict' — rubrics/run.mjs
// ---------------------------------------------------------------------------

describe("Rule 4a — 'gate_verdict'", () => {
  it('node rubrics/run.mjs --tier test → gate_verdict', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'node rubrics/run.mjs --changed foo.ts --tier test' })),
      'gate_verdict',
    );
  });

  it('absolute path with rubrics/run.mjs → gate_verdict', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 2, command: '/repo/rubrics/run.mjs --tier heavy' })),
      'gate_verdict',
    );
  });

  it('exit 127 on run.mjs → gate_verdict (gate trumps unknown-command)', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 127, command: 'node rubrics/run.mjs --tier cmd' })),
      'gate_verdict',
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 4b: 'probe' — silenced failures
// ---------------------------------------------------------------------------

describe("Rule 4b — 'probe'", () => {
  it('2>/dev/null → probe', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'ls /nonexistent 2>/dev/null' })),
      'probe',
    );
  });

  it('|| true → probe', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'some-cmd || true' })),
      'probe',
    );
  });

  it('|| echo → probe', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'cmd || echo fallback' })),
      'probe',
    );
  });

  it('||: → probe (colon builtin)', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'cmd ||:' })),
      'probe',
    );
  });

  it('|| cat → probe', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'something || cat fallback.txt' })),
      'probe',
    );
  });

  it('combined 2>/dev/null and ||true → probe', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'cmd 2>/dev/null || true' })),
      'probe',
    );
  });

  it('exit 2 with 2>/dev/null → probe (any nonzero)', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 2, command: 'find . -name "*.ts" 2>/dev/null' })),
      'probe',
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 4c: 'no_match' — grep exit 1
// ---------------------------------------------------------------------------

describe("Rule 4c — 'no_match'", () => {
  it('grep exit 1 (leading) → no_match', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'grep -r "pattern" .' })),
      'no_match',
    );
  });

  it('rg exit 1 → no_match', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'rg "TODO" apps/' })),
      'no_match',
    );
  });

  it('egrep exit 1 → no_match', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'egrep "foo|bar" file.txt' })),
      'no_match',
    );
  });

  it('fgrep exit 1 → no_match', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'fgrep "literal" README.md' })),
      'no_match',
    );
  });

  it('piped grep exit 1 → no_match', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'cat file.txt | grep "missing"' })),
      'no_match',
    );
  });

  it('grep exit 2 → failure (real error, not no-match)', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 2, command: 'grep -r "pattern" .' })),
      'failure',
    );
  });

  it('grep exit 127 → failure (command not found)', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 127, command: 'grep "pattern" file' })),
      'failure',
    );
  });

  it('grep exit 1 with 2>/dev/null → probe (probe rule wins first)', () => {
    // 4b (probe) is checked before 4c (no_match)
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'grep "x" file 2>/dev/null' })),
      'probe',
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 4d: 'policy_block'
// ---------------------------------------------------------------------------

describe("Rule 4d — 'policy_block'", () => {
  it('title contains "User refused permission" → policy_block', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, title: 'User refused permission' })),
      'policy_block',
    );
  });

  it('body contains "Hook rejected" → policy_block', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, body: 'Hook rejected: git-guard.mjs denied push' })),
      'policy_block',
    );
  });

  it('title contains "PreToolUse hook blocked" → policy_block', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, title: 'PreToolUse hook blocked', command: 'git push' })),
      'policy_block',
    );
  });

  it('body contains "user refused permission" (lowercase) → policy_block', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, body: 'user refused permission for bash' })),
      'policy_block',
    );
  });

  it('unrelated title/body with exit 1 → failure (not policy_block)', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, title: 'npm install failed', body: 'ERR_MODULE_NOT_FOUND' })),
      'failure',
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 4e: 'failure' — fallthrough
// ---------------------------------------------------------------------------

describe("Rule 4e — 'failure' fallthrough", () => {
  it('bash exit 1 with plain command → failure', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, command: 'npm install' })),
      'failure',
    );
  });

  it('bash exit 127 → failure (command not found)', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 127, command: 'nonexistent-tool' })),
      'failure',
    );
  });

  it('exit 1 with null command → failure', () => {
    assert.strictEqual(classifyExit(ev({ exit_code: 1, command: null })), 'failure');
  });

  it('exit 1 with empty command → failure', () => {
    assert.strictEqual(classifyExit(ev({ exit_code: 1, command: '' })), 'failure');
  });

  it('tsc --noEmit exit 1 → failure', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, type: 'test', command: 'pnpm -C apps/web exec tsc --noEmit' })),
      'failure',
    );
  });

  it('pnpm test exit 1 → failure', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 1, type: 'test', command: 'pnpm test' })),
      'failure',
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases / boundary conditions
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('exit_code undefined treated as null → na for non-error type', () => {
    // ExitEvent allows exit_code to be undefined (optional field)
    const e: ExitEvent = { type: 'bash' }; // exit_code absent
    assert.strictEqual(classifyExit(e), 'na');
  });

  it('exit_code=0 takes priority over grep-family command', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 0, command: 'grep "found" file.txt' })),
      'ok',
    );
  });

  it('exit_code=0 takes priority over 2>/dev/null', () => {
    assert.strictEqual(
      classifyExit(ev({ exit_code: 0, command: 'ls 2>/dev/null' })),
      'ok',
    );
  });

  it('type=error with grep command → failure (error type wins over no_match)', () => {
    assert.strictEqual(
      classifyExit(ev({ type: 'error', exit_code: 1, command: 'grep "x" file' })),
      'failure',
    );
  });
});
