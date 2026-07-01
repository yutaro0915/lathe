/**
 * Session-class classifier (second axis after project).
 *
 * Classifies every session into one of five mutually exclusive classes so that
 * consumers can distinguish genuine development work from internal harness
 * runs, auto-review jobs, synthetic fixtures, and sandbox smoke tests.
 *
 * Pure function — no I/O, no side effects, no node:* imports.
 * All branches are unit-tested in session-class.test.ts.
 *
 * Judgment order (first matching rule wins, per ADR 0012 §2):
 *   1. model === 'codex-auto-review'  → 'auto_review'
 *   2. model === '<synthetic>'        → 'synthetic'
 *   3. projectCwdHint contains '/Lathe/sandbox/' or 'harness-codex'  → 'sandbox'
 *   4. Lathe-internal markers in title / (projectId + title)          → 'internal'
 *   5. fallthrough                                                     → 'development'
 */

export type SessionClass =
  | 'development'
  | 'internal'
  | 'auto_review'
  | 'synthetic'
  | 'sandbox';

/** Canonical single source of truth for all valid session classes. */
export const SESSION_CLASSES: readonly SessionClass[] = [
  'development',
  'internal',
  'auto_review',
  'synthetic',
  'sandbox',
];

export interface SessionClassInput {
  model: string | null;
  projectId: string;
  projectCwdHint: string | null;
  title: string;
}

// ---------------------------------------------------------------------------
// Module-level patterns (avoid re-compiling on every call)
// ---------------------------------------------------------------------------

/** Sandbox cwd patterns — only concrete paths, not 'local:' in general. */
const SANDBOX_CWD_PATTERNS = ['/Lathe/sandbox/', 'harness-codex'] as const;

/** Title-only internal markers. */
const INTERNAL_TITLE_MARKERS = [
  'lathe-internal-analyst',
  'You are Lathe Chat',
] as const;

/**
 * Project-scoped internal title markers (only trigger when projectId contains 'lathe').
 * These match MCP-debug / monitoring sessions observed inside the lathe project.
 */
const LATHE_PROJECT_TITLE_MARKERS = ['登録セッション数', 'list_sessions'] as const;

// ---------------------------------------------------------------------------
// Public classifier
// ---------------------------------------------------------------------------

/**
 * Return the SessionClass for a session given its observable attributes.
 *
 * Rule evaluation is top-to-bottom; the first match wins.
 */
export function classifySession(s: SessionClassInput): SessionClass {
  const { model, projectId, projectCwdHint, title } = s;

  // Rule 1: codex auto-review — exact match only
  if (model === 'codex-auto-review') return 'auto_review';

  // Rule 2: synthetic fixture — exact match only
  if (model === '<synthetic>') return 'synthetic';

  // Rule 3: sandbox — specific cwd paths only (not 'local:' in general)
  const cwd = projectCwdHint ?? '';
  if (SANDBOX_CWD_PATTERNS.some((p) => cwd.includes(p))) return 'sandbox';

  // Rule 4: Lathe-internal — title-only markers
  if (INTERNAL_TITLE_MARKERS.some((m) => title.includes(m))) return 'internal';

  // Rule 4 (continued): project-scoped markers
  if (
    projectId.includes('lathe') &&
    LATHE_PROJECT_TITLE_MARKERS.some((m) => title.includes(m))
  ) {
    return 'internal';
  }

  // Rule 5: everything else is development
  return 'development';
}
