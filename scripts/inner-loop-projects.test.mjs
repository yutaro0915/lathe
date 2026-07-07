// Tests for inner-loop-projects.mjs pure helpers (ADR 0035 §7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECTS_PROJECT_ID,
  PROJECTS_STATUS_OPTIONS,
  findProjectItemId,
  extractStatusOptionId,
  isReadyOptionId,
  queryProjectItem,
  updateProjectItemStatus,
} from './inner-loop-projects.mjs';

// --- findProjectItemId ---

test('findProjectItemId: returns item id when project id matches', () => {
  const nodes = [
    { id: 'PVTI_other', project: { id: 'PVT_other' } },
    { id: 'PVTI_target', project: { id: PROJECTS_PROJECT_ID } },
  ];
  assert.equal(findProjectItemId(nodes), 'PVTI_target');
});

test('findProjectItemId: returns null when no matching project', () => {
  const nodes = [{ id: 'PVTI_other', project: { id: 'PVT_other' } }];
  assert.equal(findProjectItemId(nodes), null);
});

test('findProjectItemId: returns null for empty or null input', () => {
  assert.equal(findProjectItemId([]), null);
  assert.equal(findProjectItemId(null), null);
  assert.equal(findProjectItemId(undefined), null);
});

// --- extractStatusOptionId ---

test('extractStatusOptionId: returns optionId from single-select field value', () => {
  assert.equal(extractStatusOptionId({ optionId: '61e4505c' }), '61e4505c');
});

test('extractStatusOptionId: returns null for null/missing field', () => {
  assert.equal(extractStatusOptionId(null), null);
  assert.equal(extractStatusOptionId(undefined), null);
  assert.equal(extractStatusOptionId({}), null);
});

// --- isReadyOptionId ---

test('isReadyOptionId: returns true for Ready option id', () => {
  assert.equal(isReadyOptionId(PROJECTS_STATUS_OPTIONS.Ready), true);
});

test('isReadyOptionId: returns false for other option ids', () => {
  assert.equal(isReadyOptionId(PROJECTS_STATUS_OPTIONS.Backlog), false);
  assert.equal(isReadyOptionId(PROJECTS_STATUS_OPTIONS.InProgress), false);
  assert.equal(isReadyOptionId(null), false);
  assert.equal(isReadyOptionId(undefined), false);
});

// --- queryProjectItem (injected spawnSync) ---

test('queryProjectItem: returns ok=true with itemId and optionId when issue is in project', () => {
  const fakeOutput = JSON.stringify({
    data: {
      repository: {
        issue: {
          projectItems: {
            nodes: [
              {
                id: 'PVTI_abc',
                project: { id: PROJECTS_PROJECT_ID },
                fieldValueByName: { optionId: PROJECTS_STATUS_OPTIONS.Ready },
              },
            ],
          },
        },
      },
    },
  });
  const result = queryProjectItem(42, {
    spawnSync: () => ({ status: 0, stdout: fakeOutput, stderr: '' }),
  });
  assert.deepEqual(result, { ok: true, itemId: 'PVTI_abc', optionId: PROJECTS_STATUS_OPTIONS.Ready });
});

test('queryProjectItem: returns ok=true with nulls when issue is not in project', () => {
  const fakeOutput = JSON.stringify({
    data: { repository: { issue: { projectItems: { nodes: [] } } } },
  });
  const result = queryProjectItem(42, {
    spawnSync: () => ({ status: 0, stdout: fakeOutput, stderr: '' }),
  });
  assert.deepEqual(result, { ok: true, itemId: null, optionId: null });
});

test('queryProjectItem: returns ok=false when gh fails', () => {
  const result = queryProjectItem(42, {
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'gh error' }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('gh error'));
});

test('queryProjectItem: returns ok=false when JSON is invalid', () => {
  const result = queryProjectItem(42, {
    spawnSync: () => ({ status: 0, stdout: 'not json', stderr: '' }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('JSON parse error'));
});

// --- updateProjectItemStatus (injected spawnSync) ---

test('updateProjectItemStatus: returns ok=true on success', () => {
  const calls = [];
  const result = updateProjectItemStatus('PVTI_abc', PROJECTS_STATUS_OPTIONS.InProgress, {
    spawnSync: (cmd, args, opts) => { calls.push({ cmd, args }); return { status: 0, stdout: '{}', stderr: '' }; },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.ok(calls[0].args.some((a) => a.includes('updateProjectV2ItemFieldValue')));
  assert.ok(calls[0].args.some((a) => a.includes(PROJECTS_STATUS_OPTIONS.InProgress)));
});

test('updateProjectItemStatus: returns ok=false when gh fails', () => {
  const result = updateProjectItemStatus('PVTI_abc', PROJECTS_STATUS_OPTIONS.InProgress, {
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'mutation failed' }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('mutation failed'));
});
