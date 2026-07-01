/**
 * Unit tests for session-class classifier.
 * No DB, no I/O. Runs via `node --import tsx --test`.
 *
 * Coverage:
 *  - Each SessionClass has at least one positive case
 *  - Fallthrough → 'development' is explicitly tested
 *  - Regression anchors:
 *    * local: real-dev paths (Sanpyou, asobiba) must NOT become 'sandbox'
 *    * sandbox concrete paths DO become 'sandbox'
 *    * codex-auto-review is exact-match only (substring must not trigger)
 *    * internal markers each fire independently
 *    * "疑わしきは development" — ambiguous → development
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySession, SESSION_CLASSES } from './session-class';
import type { SessionClassInput } from './session-class';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function s(overrides: Partial<SessionClassInput>): SessionClassInput {
  return {
    model: 'claude-sonnet-4-5',
    projectId: 'local-Users-cherie-dev-myapp',
    projectCwdHint: 'local:/Users/cherie/dev/myapp',
    title: 'Implement feature X',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// SESSION_CLASSES constant
// ---------------------------------------------------------------------------

describe('SESSION_CLASSES constant', () => {
  it('contains all five classes', () => {
    const expected = new Set(['development', 'internal', 'auto_review', 'synthetic', 'sandbox']);
    assert.deepStrictEqual(new Set([...SESSION_CLASSES]), expected);
  });

  it('has no duplicates', () => {
    assert.strictEqual(SESSION_CLASSES.length, new Set(SESSION_CLASSES).size);
  });
});

// ---------------------------------------------------------------------------
// Rule 1: auto_review — exact model match
// ---------------------------------------------------------------------------

describe("Rule 1 — 'auto_review'", () => {
  it('codex-auto-review model → auto_review', () => {
    assert.strictEqual(classifySession(s({ model: 'codex-auto-review' })), 'auto_review');
  });

  it('model prefix match does NOT trigger — only exact', () => {
    assert.strictEqual(classifySession(s({ model: 'codex-auto-review-v2' })), 'development');
  });

  it('substring does NOT trigger — only exact', () => {
    assert.strictEqual(classifySession(s({ model: 'my-codex-auto-review' })), 'development');
  });
});

// ---------------------------------------------------------------------------
// Rule 2: synthetic — exact model match
// ---------------------------------------------------------------------------

describe("Rule 2 — 'synthetic'", () => {
  it('<synthetic> model → synthetic', () => {
    assert.strictEqual(classifySession(s({ model: '<synthetic>' })), 'synthetic');
  });

  it('model containing <synthetic> but not exact does NOT trigger', () => {
    assert.strictEqual(classifySession(s({ model: 'test-<synthetic>-v1' })), 'development');
  });
});

// ---------------------------------------------------------------------------
// Rule 3: sandbox — specific cwd paths only
// ---------------------------------------------------------------------------

describe("Rule 3 — 'sandbox'", () => {
  it('/Lathe/sandbox/ in cwd → sandbox', () => {
    assert.strictEqual(
      classifySession(s({ projectCwdHint: '/Users/cherie/dev/Lathe/sandbox/smoke-test' })),
      'sandbox',
    );
  });

  it('harness-codex in cwd → sandbox', () => {
    assert.strictEqual(
      classifySession(s({ projectCwdHint: 'harness-codex-20260701' })),
      'sandbox',
    );
  });

  it('harness-codex as project cwd prefix → sandbox', () => {
    assert.strictEqual(
      classifySession(s({ projectCwdHint: '/tmp/harness-codex-run-abc' })),
      'sandbox',
    );
  });

  // ---- Regression: local: real-dev paths must NOT become sandbox ----

  it('local:/Users/cherie/dev/Sanpyou → development (not sandbox)', () => {
    assert.strictEqual(
      classifySession(s({ projectCwdHint: 'local:/Users/cherie/dev/Sanpyou' })),
      'development',
    );
  });

  it('local:/Users/cherie/dev/asobiba/foo → development (not sandbox)', () => {
    assert.strictEqual(
      classifySession(s({ projectCwdHint: 'local:/Users/cherie/dev/asobiba/foo' })),
      'development',
    );
  });

  it('local: generic path without sandbox markers → development', () => {
    assert.strictEqual(
      classifySession(s({ projectCwdHint: 'local:/Users/cherie/dev/SomeOtherProject' })),
      'development',
    );
  });

  it('null cwd → development (not sandbox)', () => {
    assert.strictEqual(classifySession(s({ projectCwdHint: null })), 'development');
  });
});

// ---------------------------------------------------------------------------
// Rule 4: internal — title-only markers
// ---------------------------------------------------------------------------

describe("Rule 4 — 'internal' (title-only markers)", () => {
  it('title contains lathe-internal-analyst → internal', () => {
    assert.strictEqual(
      classifySession(s({ title: 'Session with lathe-internal-analyst-hybrid-v1' })),
      'internal',
    );
  });

  it('title is exactly lathe-internal-analyst → internal', () => {
    assert.strictEqual(
      classifySession(s({ title: 'lathe-internal-analyst' })),
      'internal',
    );
  });

  it('title contains You are Lathe Chat → internal', () => {
    assert.strictEqual(
      classifySession(s({ title: 'You are Lathe Chat: analyze sessions' })),
      'internal',
    );
  });

  it('title is exactly You are Lathe Chat → internal', () => {
    assert.strictEqual(
      classifySession(s({ title: 'You are Lathe Chat' })),
      'internal',
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 4 (cont.): internal — project-scoped markers
// ---------------------------------------------------------------------------

describe("Rule 4 — 'internal' (project-scoped MCP-debug markers)", () => {
  it('lathe projectId + title contains 登録セッション数 → internal', () => {
    assert.strictEqual(
      classifySession(
        s({ projectId: 'local-Users-cherie-dev-lathe', title: '登録セッション数を確認' }),
      ),
      'internal',
    );
  });

  it('lathe projectId + title contains list_sessions → internal', () => {
    assert.strictEqual(
      classifySession(
        s({ projectId: 'lathe-project', title: 'debug list_sessions MCP' }),
      ),
      'internal',
    );
  });

  it('non-lathe projectId + title contains 登録セッション数 → development (not internal)', () => {
    // project-scoped marker requires projectId to contain 'lathe'
    assert.strictEqual(
      classifySession(
        s({ projectId: 'other-project', title: '登録セッション数を確認' }),
      ),
      'development',
    );
  });

  it('non-lathe projectId + title contains list_sessions → development', () => {
    assert.strictEqual(
      classifySession(
        s({ projectId: 'my-app', title: 'handle list_sessions endpoint' }),
      ),
      'development',
    );
  });
});

// ---------------------------------------------------------------------------
// Rule 5: development (fallthrough)
// ---------------------------------------------------------------------------

describe("Rule 5 — 'development' fallthrough", () => {
  it('ordinary session → development', () => {
    assert.strictEqual(classifySession(s({})), 'development');
  });

  it('null model → development', () => {
    assert.strictEqual(classifySession(s({ model: null })), 'development');
  });

  it('real claude model → development', () => {
    assert.strictEqual(classifySession(s({ model: 'claude-opus-4-5' })), 'development');
  });

  it('gpt-5 model → development', () => {
    assert.strictEqual(classifySession(s({ model: 'gpt-5' })), 'development');
  });

  it('empty title, non-lathe project → development', () => {
    assert.strictEqual(classifySession(s({ title: '', projectId: 'some-project' })), 'development');
  });

  // "疑わしきは development" — borderline cases must stay development
  it('title with lathe keyword but not a full internal marker → development', () => {
    // "lathe" alone in title should NOT trigger internal
    assert.strictEqual(
      classifySession(s({ title: 'Refactor lathe query logic', projectId: 'other' })),
      'development',
    );
  });

  it('cwd containing sandbox as part of a non-matching word → development', () => {
    // 'my-sandbox-project' does not contain '/Lathe/sandbox/' or 'harness-codex'
    assert.strictEqual(
      classifySession(s({ projectCwdHint: 'local:/Users/cherie/dev/my-sandbox-project' })),
      'development',
    );
  });
});

// ---------------------------------------------------------------------------
// Priority ordering — earlier rules beat later rules
// ---------------------------------------------------------------------------

describe('Rule priority ordering', () => {
  it('auto_review beats sandbox cwd', () => {
    assert.strictEqual(
      classifySession(
        s({
          model: 'codex-auto-review',
          projectCwdHint: '/Users/cherie/dev/Lathe/sandbox/x',
        }),
      ),
      'auto_review',
    );
  });

  it('auto_review beats internal title', () => {
    assert.strictEqual(
      classifySession(
        s({
          model: 'codex-auto-review',
          title: 'You are Lathe Chat',
        }),
      ),
      'auto_review',
    );
  });

  it('synthetic beats sandbox cwd', () => {
    assert.strictEqual(
      classifySession(
        s({
          model: '<synthetic>',
          projectCwdHint: '/Users/cherie/dev/Lathe/sandbox/x',
        }),
      ),
      'synthetic',
    );
  });

  it('sandbox beats internal title', () => {
    assert.strictEqual(
      classifySession(
        s({
          projectCwdHint: '/Users/cherie/dev/Lathe/sandbox/run-1',
          title: 'You are Lathe Chat',
        }),
      ),
      'sandbox',
    );
  });
});
