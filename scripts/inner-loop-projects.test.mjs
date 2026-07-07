// Tests for inner-loop-projects.mjs (ADR 0035 §7): Status field/option の
// GraphQL 名前解決（#201 分解 5 — 2026-07-07 の盤面再構築 incident で option id
// 直書きが全滅したため、名前が契約・id は実行時解決）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECTS_PROJECT_ID,
  PROJECTS_STATUS_FIELD_NAME,
  PROJECTS_STATUS_NAMES,
  findProjectItemId,
  extractStatusName,
  isReadyStatusName,
  parseStatusField,
  resolveStatusField,
  getStatusField,
  resetStatusFieldCache,
  queryProjectItem,
  trySetProjectStatus,
  updateProjectItemStatus,
} from './inner-loop-projects.mjs';

beforeEach(() => resetStatusFieldCache());

const FIELD_RESPONSE = JSON.stringify({
  data: {
    node: {
      field: {
        id: 'PVTSSF_new',
        options: [
          { id: 'opt-backlog', name: 'Backlog' },
          { id: 'opt-approval', name: 'Approval' },
          { id: 'opt-ready', name: 'Ready' },
          { id: 'opt-inprogress', name: 'In progress' },
          { id: 'opt-inreview', name: 'In review' },
          { id: 'opt-escalated', name: 'Escalated' },
          { id: 'opt-done', name: 'Done' },
        ],
      },
    },
  },
});

// --- constants ---

test('PROJECTS_STATUS_NAMES: carries the seven board columns by name (#201 盤面列)', () => {
  assert.deepEqual(Object.values(PROJECTS_STATUS_NAMES), [
    'Backlog', 'Approval', 'Ready', 'In progress', 'In review', 'Escalated', 'Done',
  ]);
});

// --- findProjectItemId ---

test('findProjectItemId: returns item id when project id matches', () => {
  const nodes = [
    { id: 'PVTI_other', project: { id: 'PVT_other' } },
    { id: 'PVTI_target', project: { id: PROJECTS_PROJECT_ID } },
  ];
  assert.equal(findProjectItemId(nodes), 'PVTI_target');
});

test('findProjectItemId: returns null when no matching project / empty input', () => {
  assert.equal(findProjectItemId([{ id: 'PVTI_other', project: { id: 'PVT_other' } }]), null);
  assert.equal(findProjectItemId([]), null);
  assert.equal(findProjectItemId(null), null);
});

// --- extractStatusName / isReadyStatusName ---

test('extractStatusName: returns name from single-select field value', () => {
  assert.equal(extractStatusName({ name: 'Ready' }), 'Ready');
});

test('extractStatusName: returns null for null/missing field', () => {
  assert.equal(extractStatusName(null), null);
  assert.equal(extractStatusName(undefined), null);
  assert.equal(extractStatusName({}), null);
});

test('isReadyStatusName: matches only the Ready column name', () => {
  assert.equal(isReadyStatusName(PROJECTS_STATUS_NAMES.Ready), true);
  assert.equal(isReadyStatusName('Backlog'), false);
  assert.equal(isReadyStatusName(null), false);
  assert.equal(isReadyStatusName(undefined), false);
});

// --- parseStatusField (pure) ---

test('parseStatusField: extracts fieldId and option name→id map', () => {
  const parsed = parseStatusField(JSON.parse(FIELD_RESPONSE));
  assert.equal(parsed.fieldId, 'PVTSSF_new');
  assert.equal(parsed.optionsByName.Ready, 'opt-ready');
  assert.equal(parsed.optionsByName['In progress'], 'opt-inprogress');
});

test('parseStatusField: missing/malformed shapes return null', () => {
  assert.equal(parseStatusField(null), null);
  assert.equal(parseStatusField({}), null);
  assert.equal(parseStatusField({ data: { node: { field: null } } }), null);
  assert.equal(parseStatusField({ data: { node: { field: { id: 'x', options: 'nope' } } } }), null);
});

// --- resolveStatusField / getStatusField (injected spawnSync) ---

test('resolveStatusField: resolves field/options by name via gh api graphql', () => {
  const calls = [];
  const result = resolveStatusField({
    spawnSync: (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: FIELD_RESPONSE, stderr: '' }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.fieldId, 'PVTSSF_new');
  assert.equal(result.optionsByName.Escalated, 'opt-escalated');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.some((a) => a.includes(`fieldName=${PROJECTS_STATUS_FIELD_NAME}`)));
  assert.ok(calls[0].args.some((a) => a.includes(PROJECTS_PROJECT_ID)));
});

test('resolveStatusField: gh failure / bad JSON / missing field are non-ok', () => {
  assert.equal(resolveStatusField({ spawnSync: () => ({ status: 1, stdout: '', stderr: 'gh error' }) }).ok, false);
  assert.equal(resolveStatusField({ spawnSync: () => ({ status: 0, stdout: 'not json', stderr: '' }) }).ok, false);
  const missing = resolveStatusField({ spawnSync: () => ({ status: 0, stdout: '{"data":{"node":{}}}', stderr: '' }) });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /could not resolve field/);
});

test('getStatusField: success is cached — 1 パス 1 回 (#201 分解 5)', () => {
  let spawnCount = 0;
  const deps = { spawnSync: () => { spawnCount += 1; return { status: 0, stdout: FIELD_RESPONSE, stderr: '' }; } };
  const first = getStatusField(deps);
  const second = getStatusField(deps);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(spawnCount, 1, 'resolution runs once per process pass');
});

test('getStatusField: failure is NOT cached — a later call may recover', () => {
  let spawnCount = 0;
  const responses = [
    { status: 1, stdout: '', stderr: 'transient' },
    { status: 0, stdout: FIELD_RESPONSE, stderr: '' },
  ];
  const deps = { spawnSync: () => responses[spawnCount++] };
  assert.equal(getStatusField(deps).ok, false);
  assert.equal(getStatusField(deps).ok, true);
  assert.equal(spawnCount, 2);
});

// --- queryProjectItem (injected spawnSync) ---

test('queryProjectItem: returns itemId and statusName when issue is in project', () => {
  const fakeOutput = JSON.stringify({
    data: {
      repository: {
        issue: {
          projectItems: {
            nodes: [
              {
                id: 'PVTI_abc',
                project: { id: PROJECTS_PROJECT_ID },
                fieldValueByName: { name: 'Ready' },
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
  assert.deepEqual(result, { ok: true, itemId: 'PVTI_abc', statusName: 'Ready' });
});

test('queryProjectItem: returns ok=true with nulls when issue is not in project', () => {
  const fakeOutput = JSON.stringify({
    data: { repository: { issue: { projectItems: { nodes: [] } } } },
  });
  const result = queryProjectItem(42, {
    spawnSync: () => ({ status: 0, stdout: fakeOutput, stderr: '' }),
  });
  assert.deepEqual(result, { ok: true, itemId: null, statusName: null });
});

test('queryProjectItem: gh failure / invalid JSON are non-ok', () => {
  const failed = queryProjectItem(42, { spawnSync: () => ({ status: 1, stdout: '', stderr: 'gh error' }) });
  assert.equal(failed.ok, false);
  assert.ok(failed.reason.includes('gh error'));
  const bad = queryProjectItem(42, { spawnSync: () => ({ status: 0, stdout: 'not json', stderr: '' }) });
  assert.equal(bad.ok, false);
  assert.ok(bad.reason.includes('JSON parse error'));
});

// --- trySetProjectStatus (name resolution + non-fatal skip) ---

function itemResponseFor(itemId) {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          projectItems: {
            nodes: [{ id: itemId, project: { id: PROJECTS_PROJECT_ID }, fieldValueByName: { name: 'Backlog' } }],
          },
        },
      },
    },
  });
}

test('trySetProjectStatus: resolves ids by name and mutates with them', () => {
  const calls = [];
  const logs = [];
  const deps = {
    log: (msg) => logs.push(msg),
    spawnSync: (cmd, args) => {
      calls.push(args.find((a) => a.startsWith('query=')) ?? '');
      if (calls.length === 1) return { status: 0, stdout: FIELD_RESPONSE, stderr: '' }; // field resolution
      if (calls.length === 2) return { status: 0, stdout: itemResponseFor('PVTI_abc'), stderr: '' }; // item query
      // mutation — assert the resolved ids ride along
      assert.ok(args.some((a) => a === 'fieldId=PVTSSF_new'));
      assert.ok(args.some((a) => a === 'optionId=opt-inreview'));
      assert.ok(args.some((a) => a === 'itemId=PVTI_abc'));
      return { status: 0, stdout: '{}', stderr: '' };
    },
  };
  trySetProjectStatus(9, PROJECTS_STATUS_NAMES.InReview, deps);
  assert.equal(calls.length, 3, 'field resolution → item query → mutation');
  assert.ok(logs.some((l) => l.includes('status → In review')));
});

test('trySetProjectStatus: field resolution failure skips projection (non-fatal)', () => {
  let spawnCount = 0;
  const logs = [];
  trySetProjectStatus(9, PROJECTS_STATUS_NAMES.InProgress, {
    log: (msg) => logs.push(msg),
    spawnSync: () => { spawnCount += 1; return { status: 1, stdout: '', stderr: 'no auth' }; },
  });
  assert.equal(spawnCount, 1, 'stops at resolution — no item query, no mutation');
  assert.ok(logs.some((l) => l.includes('Status field resolution failed') && l.includes('skipping projection')));
});

test('trySetProjectStatus: unknown status name skips projection (non-fatal)', () => {
  let spawnCount = 0;
  const logs = [];
  trySetProjectStatus(9, 'Nonexistent column', {
    log: (msg) => logs.push(msg),
    spawnSync: () => { spawnCount += 1; return { status: 0, stdout: FIELD_RESPONSE, stderr: '' }; },
  });
  assert.equal(spawnCount, 1, 'stops after resolution');
  assert.ok(logs.some((l) => l.includes('"Nonexistent column" not found')));
});

test('trySetProjectStatus: issue not in project skips the mutation', () => {
  const logs = [];
  let spawnCount = 0;
  trySetProjectStatus(9, PROJECTS_STATUS_NAMES.InProgress, {
    log: (msg) => logs.push(msg),
    spawnSync: () => {
      spawnCount += 1;
      if (spawnCount === 1) return { status: 0, stdout: FIELD_RESPONSE, stderr: '' };
      return { status: 0, stdout: JSON.stringify({ data: { repository: { issue: { projectItems: { nodes: [] } } } } }), stderr: '' };
    },
  });
  assert.equal(spawnCount, 2, 'no mutation call');
  assert.ok(logs.some((l) => l.includes('not in project')));
});

// --- updateProjectItemStatus (injected spawnSync) ---

test('updateProjectItemStatus: sends resolved fieldId/optionId, ok on success', () => {
  const calls = [];
  const result = updateProjectItemStatus('PVTI_abc', { fieldId: 'PVTSSF_new', optionId: 'opt-done' }, {
    spawnSync: (cmd, args) => { calls.push({ cmd, args }); return { status: 0, stdout: '{}', stderr: '' }; },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.ok(calls[0].args.some((a) => a.includes('updateProjectV2ItemFieldValue')));
  assert.ok(calls[0].args.some((a) => a === 'fieldId=PVTSSF_new'));
  assert.ok(calls[0].args.some((a) => a === 'optionId=opt-done'));
});

test('updateProjectItemStatus: returns ok=false when gh fails', () => {
  const result = updateProjectItemStatus('PVTI_abc', { fieldId: 'f', optionId: 'o' }, {
    spawnSync: () => ({ status: 1, stdout: '', stderr: 'mutation failed' }),
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes('mutation failed'));
});
