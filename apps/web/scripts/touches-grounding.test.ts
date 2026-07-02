import { strict as assert } from 'node:assert';
import { before, test } from 'node:test';
import {
  buildGroundingReport,
  compareTouches,
  findAdvisoryOpenOverlaps,
  formatMarkdown,
  loadQueueHelpers,
  makeUnavailableReport,
  type GithubIssue,
} from './touches-grounding';

before(async () => {
  await loadQueueHelpers();
});

function issue({
  number,
  title = `issue ${number}`,
  body = '',
  labels = ['inner-loop'],
  closedAt = null,
}: {
  number: number;
  title?: string;
  body?: string;
  labels?: string[];
  closedAt?: string | null;
}): GithubIssue {
  return {
    number,
    title,
    body,
    labels: labels.map((name) => ({ name })),
    createdAt: '2026-07-01T00:00:00Z',
    closedAt,
  };
}

test('import-main guard: importing touches-grounding does not execute DB or GitHub access', () => {
  assert.equal(typeof compareTouches, 'function');
});

test('compareTouches: directory and file touches overlap at path boundaries', () => {
  const result = compareTouches(
    ['apps/web/scripts'],
    ['apps/web/scripts/touches-grounding.ts', 'apps/web/scriptset/not-covered.ts'],
  );

  assert.deepEqual(result.missingActual, ['apps/web/scriptset/not-covered.ts']);
  assert.deepEqual(result.unusedDeclared, []);
  assert.equal(result.precision, 1);
  assert.equal(result.recall, 0.5);
});

test('compareTouches: precision, recall, missingActual, and unusedDeclared are falsifiable', () => {
  const result = compareTouches(
    [
      'apps/web/scripts/touches-grounding.ts',
      'apps/web/lib/postgres.ts',
      'scripts/inner-loop.mjs',
    ],
    [
      'apps/web/scripts/touches-grounding.ts',
      'apps/web/scripts/touches-grounding.test.ts',
      'scripts/inner-loop.mjs',
    ],
  );

  assert.deepEqual(result.declaredTouches, [
    'apps/web/lib/postgres.ts',
    'apps/web/scripts/touches-grounding.ts',
    'scripts/inner-loop.mjs',
  ]);
  assert.deepEqual(result.actualPaths, [
    'apps/web/scripts/touches-grounding.test.ts',
    'apps/web/scripts/touches-grounding.ts',
    'scripts/inner-loop.mjs',
  ]);
  assert.deepEqual(result.missingActual, ['apps/web/scripts/touches-grounding.test.ts']);
  assert.deepEqual(result.unusedDeclared, ['apps/web/lib/postgres.ts']);
  assert.equal(result.precision, 2 / 3);
  assert.equal(result.recall, 2 / 3);
});

test('compareTouches: absent declared or actual paths produce null denominators', () => {
  assert.equal(compareTouches([], ['apps/web/app/page.tsx']).precision, null);
  assert.equal(compareTouches(['apps/web/app/page.tsx'], []).recall, null);
});

test('buildGroundingReport: target without historical actual still gets similar and advisory report', () => {
  const target = issue({
    number: 42,
    title: 'feat(workflow): add touches grounding report',
    body: [
      'Depends-on: #41',
      'Touches: apps/web/scripts/touches-grounding.ts',
      'This report compares workflow issue touch hints against changed files.',
    ].join('\n'),
    labels: ['inner-loop', 'workflow'],
  });
  const sibling = issue({
    number: 43,
    title: 'feat(workflow): add touches review report',
    body: [
      'Touches: apps/web/scripts',
      'This report compares workflow issue touch hints against review notes.',
    ].join('\n'),
    labels: ['inner-loop', 'workflow'],
  });
  const dependent = issue({
    number: 44,
    title: 'feat(workflow): dependent overlap',
    body: 'Depends-on: #42\nTouches: apps/web/scripts',
    labels: ['inner-loop', 'workflow'],
  });

  const report = buildGroundingReport({
    innerLoopIssues: [sibling, dependent],
    targetIssue: target,
    actualByIssue: new Map(),
    now: new Date('2026-07-02T00:00:00Z'),
  });

  assert.equal(report.status, 'ok');
  assert.equal(report.targetIssue, 42);
  assert.equal(report.issues.length, 1);
  assert.deepEqual(report.issues[0].actualPaths, []);
  assert.equal(report.issues[0].recall, null);
  assert.ok(
    report.issues[0].similarIssues.some((candidate) => candidate.issueNumber === 43),
    'sibling issue should be listed as advisory similar issue',
  );
  assert.ok(
    report.advisoryOpenOverlaps.some(
      (overlap) => overlap.leftIssueNumber === 42 && overlap.rightIssueNumber === 43,
    ),
    'undeclared dependency between overlapping open issues should be advisory',
  );
  assert.ok(
    !report.advisoryOpenOverlaps.some(
      (overlap) => overlap.leftIssueNumber === 42 && overlap.rightIssueNumber === 44,
    ),
    'declared Depends-on relationship should suppress advisory overlap',
  );
});

test('findAdvisoryOpenOverlaps: historical actual paths participate in open overlap checks', () => {
  const overlaps = findAdvisoryOpenOverlaps(
    [
      issue({ number: 10, body: 'Touches: docs/readme.md' }),
      issue({ number: 11, body: 'Touches: scripts/inner-loop.mjs' }),
    ],
    new Map([
      [10, ['apps/web/scripts/touches-grounding.ts']],
      [11, ['apps/web/scripts']],
    ]),
  );

  assert.deepEqual(overlaps, [
    {
      leftIssueNumber: 10,
      rightIssueNumber: 11,
      leftPath: 'apps/web/scripts/touches-grounding.ts',
      rightPath: 'apps/web/scripts',
    },
  ]);
});

test('makeUnavailableReport and markdown formatting do not throw', () => {
  const report = makeUnavailableReport('database connection refused', new Date('2026-07-02T00:00:00Z'));
  const markdown = formatMarkdown(report);

  assert.equal(report.status, 'unavailable');
  assert.match(markdown, /grounding unavailable: database connection refused/);
});
