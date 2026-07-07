// Tests for escalation の issue 化 + triage 三分岐 (#201 分解 6, #117 ADR 0035 §4):
// ESCALATE 終端は対象 issue への escalation label ＋ レポート全文 comment（.escalation.md 廃止）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESCALATION_LABEL } from './inner-loop-core.mjs';
import { buildEscalationMarkdown, projectEscalation, triageEscalationCategory } from './inner-loop-escalation.mjs';

// --- buildEscalationMarkdown (report body) ---

test('buildEscalationMarkdown: plan-task runType switches the report subject', () => {
  const md = buildEscalationMarkdown({ issueNumber: 9, stage: 'PLAN', verdict: null, resultExcerpt: 'x', runType: 'plan-task' });
  assert.ok(md.includes('# escalation — plan-task issue #9'));
  const task = buildEscalationMarkdown({ issueNumber: 9, stage: 'IMPLEMENT', verdict: 'ESCALATE', resultExcerpt: 'x' });
  assert.ok(task.includes('# escalation — issue #9'));
});

// --- projectEscalation ---

function ghCall(args) {
  return args.slice(0, 3).join(' ');
}

test('projectEscalation: adds the escalation label and posts the full report as a comment', () => {
  const calls = [];
  let commentBody = null;
  const result = projectEscalation(
    { issueNumber: 42, stage: 'IMPLEMENT', verdict: 'ESCALATE', resultExcerpt: 'premise mismatch details' },
    {
      spawnSync: (cmd, args, options) => {
        calls.push({ cmd, key: ghCall(args), args });
        if (args[0] === 'issue' && args[1] === 'comment') commentBody = options?.input ?? null;
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  );
  assert.deepEqual(result, { ok: true, labelOk: true, commentOk: true });
  assert.deepEqual(calls.map((c) => c.key), ['issue edit 42', 'issue comment 42']);
  const labelArgs = calls[0].args;
  assert.equal(labelArgs[labelArgs.indexOf('--add-label') + 1], ESCALATION_LABEL);
  // レポート全文が comment（パス参照ではない）
  assert.ok(commentBody.includes('# escalation — issue #42'));
  assert.ok(commentBody.includes('stage: IMPLEMENT'));
  assert.ok(commentBody.includes('verdict: ESCALATE'));
  assert.ok(commentBody.includes('premise mismatch details'));
  assert.ok(!commentBody.includes('.escalation.md'));
});

test('projectEscalation: missing label → gh label create then retry add once', () => {
  const keys = [];
  let addAttempts = 0;
  const result = projectEscalation(
    { issueNumber: 7, stage: 'PLAN', verdict: null, resultExcerpt: 'e', runType: 'plan-task' },
    {
      spawnSync: (cmd, args) => {
        keys.push(ghCall(args));
        if (args[0] === 'issue' && args[1] === 'edit') {
          addAttempts += 1;
          return { status: addAttempts === 1 ? 1 : 0, stdout: '', stderr: 'label not found' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  );
  assert.deepEqual(keys, ['issue edit 7', `label create ${ESCALATION_LABEL}`, 'issue edit 7', 'issue comment 7']);
  assert.equal(result.ok, true);
});

test('projectEscalation: projection failure is non-fatal — warns and reports ok=false', () => {
  const logs = [];
  const result = projectEscalation(
    { issueNumber: 5, stage: 'LAND', verdict: null, resultExcerpt: 'landing failed' },
    {
      log: (msg) => logs.push(msg),
      spawnSync: () => ({ status: 1, stdout: '', stderr: 'gh down' }),
    },
  );
  assert.deepEqual(result, { ok: false, labelOk: false, commentOk: false });
  assert.ok(logs.some((l) => l.includes(`could not add ${ESCALATION_LABEL} label`)));
  assert.ok(logs.some((l) => l.includes('could not post escalation report comment')));
});

test('projectEscalation: comment failure alone still returns labelOk=true / ok=false', () => {
  const result = projectEscalation(
    { issueNumber: 5, stage: 'IMPLEMENT', verdict: 'ESCALATE', resultExcerpt: 'x' },
    {
      spawnSync: (cmd, args) => (
        args[0] === 'issue' && args[1] === 'comment'
          ? { status: 1, stdout: '', stderr: 'boom' }
          : { status: 0, stdout: '', stderr: '' }
      ),
    },
  );
  assert.deepEqual(result, { ok: false, labelOk: true, commentOk: false });
});

// --- triageEscalationCategory (ADR 0035 §4 triage 三分岐) ---

test('triageEscalationCategory: null verdict → context（UNPARSABLE 再試行済み）', () => {
  assert.equal(triageEscalationCategory({ verdict: null }), 'context');
});

test('triageEscalationCategory: UNPARSABLE → context', () => {
  assert.equal(triageEscalationCategory({ verdict: 'UNPARSABLE' }), 'context');
});

test('triageEscalationCategory: REBASE_CONFLICT → env', () => {
  assert.equal(triageEscalationCategory({ verdict: 'REBASE_CONFLICT' }), 'env');
});

test('triageEscalationCategory: MAIN_DIRTY_BACKSTOP → env', () => {
  assert.equal(triageEscalationCategory({ verdict: 'MAIN_DIRTY_BACKSTOP' }), 'env');
});

test('triageEscalationCategory: ESCALATE → decision（意思決定が必要）', () => {
  assert.equal(triageEscalationCategory({ verdict: 'ESCALATE' }), 'decision');
});

test('triageEscalationCategory: RED → decision', () => {
  assert.equal(triageEscalationCategory({ verdict: 'RED' }), 'decision');
});

test('triageEscalationCategory: その他の verdict → decision（デフォルト）', () => {
  assert.equal(triageEscalationCategory({ verdict: 'IMPL_DONE' }), 'decision');
  assert.equal(triageEscalationCategory({ verdict: 'UNKNOWN_TOKEN' }), 'decision');
});
