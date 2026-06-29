/**
 * Exit-code disposition classifier.
 *
 * Converts a raw bash/tool event into an objective "disposition" string so that
 * consumers can distinguish genuine failures from expected non-zero exits
 * (probes, gate verdicts, grep no-match, hook/policy blocks).
 *
 * Pure function — no I/O, no side effects. All branches are unit-tested.
 */

export type ExitDisposition =
  | 'na'           // event has no exit code (thinking, message, file_*, etc.)
  | 'ok'           // exit 0
  | 'gate_verdict' // rubrics/run.mjs exited non-zero — expected RED signal
  | 'probe'        // command designed to fail silently (2>/dev/null, || true, …)
  | 'no_match'     // grep/rg/egrep/fgrep exit 1 (no lines matched — not an error)
  | 'policy_block' // Claude Code hook or permission system rejected the action
  | 'failure';     // genuine unexpected failure

export interface ExitEvent {
  type: string;
  command?: string | null;
  exit_code?: number | null;
  title?: string | null;
  body?: string | null;
}

/**
 * Classify the exit disposition of a single transcript event.
 *
 * Judgment order (first matching rule wins):
 * 1. exit_code == null && type !== 'error'  → 'na'
 * 2. type === 'error'                        → 'failure'
 * 3. exit_code === 0                         → 'ok'
 * 4. exit_code !== 0:
 *    a. command contains rubrics/run.mjs     → 'gate_verdict'
 *    b. command contains 2>/dev/null / ||true / ||echo / ||: / ||cat → 'probe'
 *    c. grep-family binary, exit === 1       → 'no_match'
 *    d. title/body contains known hook-refusal markers → 'policy_block'
 *    e. fallthrough                          → 'failure'
 */
export function classifyExit(ev: ExitEvent): ExitDisposition {
  const { type, exit_code, command, title, body } = ev;

  // Rule 1: no exit code and not an explicit error event
  if (exit_code == null && type !== 'error') return 'na';

  // Rule 2: explicit error event (parse error, tool error, etc.)
  if (type === 'error') return 'failure';

  // Rule 3: clean exit
  if (exit_code === 0) return 'ok';

  // Rules 4a–4e: exit_code !== 0
  const cmd = command ?? '';

  // 4a: gate verdict — rubrics/run.mjs returning RED is expected behaviour
  if (cmd.includes('rubrics/run.mjs')) return 'gate_verdict';

  // 4b: probe — caller already silenced the failure with a shell idiom
  if (
    cmd.includes('2>/dev/null') ||
    /\|\|\s*true\b/.test(cmd) ||
    /\|\|\s*echo\b/.test(cmd) ||
    /\|\|\s*:(?:\s|$)/.test(cmd) || cmd.endsWith('||:') ||
    /\|\|\s*cat\b/.test(cmd)
  ) {
    return 'probe';
  }

  // 4c: grep no-match — exit 1 from grep-family means "found nothing", not error.
  //     exit ≥ 2 from grep means a real error, so fall through to failure.
  if (exit_code === 1 && isGrepFamily(cmd)) return 'no_match';

  // 4d: policy / hook block — look for known refusal strings in title/body.
  //     Only match when we are confident; ambiguous cases fall to 'failure'.
  if (isPolicyBlock(title, body)) return 'policy_block';

  // 4e: genuine failure
  return 'failure';
}

// ---------------------------------------------------------------------------
// Helpers (unexported implementation details)
// ---------------------------------------------------------------------------

/**
 * Returns true when the effective binary being executed belongs to the
 * grep family.  We check both the leading token and the first token after
 * a pipe, to handle patterns like `cat file | grep …`.
 */
function isGrepFamily(cmd: string): boolean {
  const grepRe = /(?:^|\|\s*)(?:grep|rg|egrep|fgrep)\b/;
  return grepRe.test(cmd.trim());
}

/**
 * Returns true when title or body contains a recognized Claude Code hook /
 * permission refusal marker.  We keep this conservative: only exact-ish
 * substrings that the harness is known to emit.  When uncertain → false.
 */
const POLICY_MARKERS = [
  'User refused permission',
  'user refused permission',
  'Permission denied by user',
  'Hook rejected',
  'hook rejected',
  'PreToolUse hook blocked',
  'PostToolUse hook blocked',
] as const;

function isPolicyBlock(title?: string | null, body?: string | null): boolean {
  const haystack = `${title ?? ''} ${body ?? ''}`;
  return POLICY_MARKERS.some((m) => haystack.includes(m));
}
