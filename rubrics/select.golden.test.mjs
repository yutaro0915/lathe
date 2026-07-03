#!/usr/bin/env node
// rubrics/select.golden.test.mjs — select.mjs の golden test（ADR 0021 前線 D §7）。
//   node rubrics/select.golden.test.mjs  → 全 assert 通過で "PASS" を出力、失敗で throw（exit≠0）。
//
// (a) 合成グラフでの規則別ケース（direct-scope / 2 段以上の dep-closure / declared-edge / invariant / 上位集合性）
// (b) 実グラフでの波及ケース（packages/domain のみの変更 → apps/web scope の rubric が dep-closure で発火）
//     これが eval rubric-selection-v1 の中核 criterion。旧規則（scope ∩ changed の prefix 照合）では発火しない。
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { selectRubrics, buildReverseGraph } from './select.mjs';

// --- (a) 合成グラフ ---

// barrel 経由の 2 段波及: packages/domain/src/index.ts → packages/domain/src/barrel.ts → apps/web/lib/use.ts
const synthGraph = new Map([
  ['packages/domain/src/index.ts', ['packages/domain/src/barrel.ts']],
  ['packages/domain/src/barrel.ts', ['apps/web/lib/use.ts']],
  ['apps/web/lib/use.ts', []],
]);

const synthRubrics = [
  { id: 'direct/scope-hit', scope: ['apps/web/components'] },
  { id: 'dep/closure-2hop', scope: ['apps/web/lib'] },
  { id: 'declared/edge-hit', scope: ['apps/web/other'], edges: [{ from: 'apps/web/app/globals.css', reason: 'design token 変更は styling 検査を誘発（import グラフに映らない）' }] },
  { id: 'always/invariant', scope: ['nowhere/relevant'], invariant: true },
  { id: 'never/fires', scope: ['totally/unrelated'] },
];

// direct-scope: changed が scope に直接ヒット
{
  const r = selectRubrics({ changed: ['apps/web/components/Button.tsx'], graph: synthGraph, rubrics: synthRubrics });
  const hit = r.fired.find((f) => f.id === 'direct/scope-hit');
  assert.ok(hit, 'direct-scope: apps/web/components 配下の変更で direct/scope-hit が発火すること');
  assert.equal(hit.rule, 'direct-scope', 'direct-scope: rule が direct-scope であること');
  assert.ok(r.notRun.includes('never/fires'), 'direct-scope: 無関係 rubric は not-run に入ること');
}

// dep-closure: packages/domain/src/index.ts の変更が barrel 経由で apps/web/lib に 2 段で波及
{
  const r = selectRubrics({ changed: ['packages/domain/src/index.ts'], graph: synthGraph, rubrics: synthRubrics });
  const hit = r.fired.find((f) => f.id === 'dep/closure-2hop');
  assert.ok(hit, 'dep-closure: 2 段波及（barrel 経由）で dep/closure-2hop が発火すること');
  assert.equal(hit.rule, 'dep-closure', 'dep-closure: rule が dep-closure であること');
  assert.ok(hit.via && hit.via.includes('packages/domain/src/index.ts') && hit.via.includes('apps/web/lib/use.ts'), 'dep-closure: via に起点→終点の経路が入ること');
}

// declared-edge: rubric.json の edges[].from prefix に changed が触れると発火
{
  const r = selectRubrics({ changed: ['apps/web/app/globals.css'], graph: synthGraph, rubrics: synthRubrics });
  const hit = r.fired.find((f) => f.id === 'declared/edge-hit');
  assert.ok(hit, 'declared-edge: edges[].from 配下の変更で declared/edge-hit が発火すること');
  assert.equal(hit.rule, 'declared-edge', 'declared-edge: rule が declared-edge であること');
}

// invariant: 変更集合と無関係に常時発火
{
  const r = selectRubrics({ changed: ['totally/unrelated-file.txt'], graph: synthGraph, rubrics: synthRubrics });
  const hit = r.fired.find((f) => f.id === 'always/invariant');
  assert.ok(hit, 'invariant: 変更集合と無関係でも always/invariant が発火すること');
  assert.equal(hit.rule, 'invariant', 'invariant: rule が invariant であること');
}

// 上位集合性: 旧規則（scope ∩ changed の prefix 照合）が発火するものは必ず新規則の fired に含まれる
{
  const oldRuleFires = (rubric, changed) =>
    (rubric.scope || []).some((s) => changed.some((c) => c === s || c.startsWith(s.endsWith('/') ? s : `${s}/`)));
  const changed = ['apps/web/components/Button.tsx', 'apps/web/app/globals.css'];
  const r = selectRubrics({ changed, graph: synthGraph, rubrics: synthRubrics });
  const firedIds = new Set(r.fired.map((f) => f.id));
  for (const rubric of synthRubrics) {
    if (oldRuleFires(rubric, changed)) {
      assert.ok(firedIds.has(rubric.id), `上位集合性: 旧規則で発火する ${rubric.id} は新規則でも発火すること`);
    }
  }
}

// 明示指定モード: explicit が渡されると id 一致のみ発火・規則 explicit（他の全規則は無視される）
{
  const r = selectRubrics({ changed: ['packages/domain/src/index.ts'], graph: synthGraph, rubrics: synthRubrics, explicit: ['always/invariant'] });
  assert.equal(r.fired.length, 1, '明示指定: fired は指定 id のみ');
  assert.equal(r.fired[0].id, 'always/invariant');
  assert.equal(r.fired[0].rule, 'explicit', '明示指定: rule は explicit');
  assert.ok(r.notRun.includes('dep/closure-2hop'), '明示指定: 指定外は dep-closure 条件を満たしても not-run');
}

console.log('PASS (a) 合成グラフ: direct-scope / dep-closure(2段) / declared-edge / invariant / 上位集合性 / 明示指定');

// --- (b) 実グラフでの波及ケース（eval の中核 criterion） ---

function findRubricFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...findRubricFiles(join(dir, e.name)));
    else if (e.name === 'rubric.json') out.push(join(dir, e.name));
  }
  return out;
}
const rubricsDir = join(dirname(new URL(import.meta.url).pathname), '.');
const allRubrics = findRubricFiles(rubricsDir).map((f) => ({
  id: relative(rubricsDir, dirname(f)),
  ...JSON.parse(readFileSync(f, 'utf8')),
}));

const changed = ['packages/domain/src/index.ts'];
const realGraph = buildReverseGraph(changed, { cwd: process.cwd() });
assert.ok(realGraph, '実グラフ: packages/domain は apps/web|packages を触れるのでグラフ構築が省略されないこと');

const result = selectRubrics({ changed, graph: realGraph, rubrics: allRubrics });
const firedIds = new Set(result.fired.map((f) => f.id));

// 中核 criterion: meta/typecheck（scope=["apps/web"]）は旧規則では発火しないが dep-closure で発火する。
const typecheckFired = result.fired.find((f) => f.id === 'meta/typecheck');
assert.ok(typecheckFired, '実グラフ波及: packages/domain のみの変更で meta/typecheck が発火すること');
assert.equal(typecheckFired.rule, 'dep-closure', '実グラフ波及: meta/typecheck の発火規則は dep-closure（旧規則では発火しない差分）');
assert.ok(typecheckFired.via && typecheckFired.via.startsWith('packages/domain/src/index.ts'), '実グラフ波及: via が packages/domain/src/index.ts から始まること');

// golden 期待集合: 選定変更が golden 更新を強制する形で明示リストする（実測値で固定、2026-07-03）。
const EXPECTED_FIRED_IDS = [
  'apps/web/components/no-raw-primitives',
  'apps/web/interaction/panel-reopenable',
  'apps/web/layout/authority',
  'apps/web/layout/integrity',
  'apps/web/scripts/analyst/acp-no-fallback',
  'apps/web/scripts/analyst/backfill-missing-only',
  'apps/web/scripts/ingest/incremental-integration',
  'apps/web/scripts/ingest/incremental-no-wipe',
  'apps/web/scripts/ingest/input-typeguard',
  'apps/web/scripts/verify/scratch-isolation',
  'apps/web/styling/css-valid',
  'apps/web/styling/diff-color-localized',
  'apps/web/styling/ds-v1-single',
  'apps/web/styling/no-inline-literals',
  'apps/web/styling/token-consistency',
  'boundaries',
  'file-size',
  'findings/no-generic',
  'meta/build',
  'meta/no-needless-backward-compat',
  'meta/pr-split',
  'meta/tests-accompany-changes',
  'meta/typecheck',
  'meta/unit-tests',
  'packages/domain/single-source',
  'packages/mcp/single-source',
].sort();

const actualFiredIds = [...firedIds].sort();
assert.deepEqual(actualFiredIds, EXPECTED_FIRED_IDS, `実グラフ波及: fired 集合が golden 期待リストと一致すること（実測: ${JSON.stringify(actualFiredIds)}）`);

// 上位集合性（実グラフ）: 旧規則（scope が packages/domain prefix を含む）で発火する rubric は全て fired に含まれる
const oldRuleFiredIds = allRubrics
  .filter((r) => (r.scope || []).some((s) => changed.some((c) => c === s || c.startsWith(s.endsWith('/') ? s : `${s}/`))))
  .map((r) => r.id);
for (const id of oldRuleFiredIds) {
  assert.ok(firedIds.has(id), `実グラフ上位集合性: 旧規則で発火する ${id} は新規則でも発火すること`);
}

console.log(`PASS (b) 実グラフ波及: meta/typecheck が dep-closure で発火 / fired=${result.fired.length} not-run=${result.notRun.length} / 上位集合性 ok`);
console.log('PASS: select.golden.test.mjs');
