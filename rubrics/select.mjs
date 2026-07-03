#!/usr/bin/env node
// rubrics/select.mjs — 発火の選定層（run.mjs の前段・純関数＋CLI、ADR 0021 前線 D）。
//   module: import { selectRubrics, buildReverseGraph } from './select.mjs'（golden test 対象）
//
// 設計（ADR 0021）:
//   発火(rubric) = invariant ∨（scope ∩ 影響集合 ≠ ∅）∨ declared-edge ∨ 明示指定
//   影響集合 = 変更集合 ∪ 依存グラフ上の逆依存の推移閉包（BFS・tier 非依存）
//   新選定の発火集合は常に旧規則（scope ∩ 変更集合の prefix 照合）の上位集合＝安全性の設計不変条件。
import { execSync } from 'node:child_process';

// --- 純関数（golden test 対象） ---

// scope（prefix 群）が対象集合のいずれかを覆うか。run.mjs の従来ロジックと同じ prefix 照合。
function scopeCoversAny(scope, targets) {
  return (scope || []).some((s) =>
    targets.some((t) => t === s || t.startsWith(s.endsWith('/') ? s : `${s}/`))
  );
}

// declared-edge: rubric.json の任意フィールド edges: [{from, reason}] の from prefix に
// changed のいずれかが触れるか。
function declaredEdgeHit(rubric, changed) {
  const edges = Array.isArray(rubric.edges) ? rubric.edges : [];
  for (const e of edges) {
    if (!e || !e.from) continue;
    const from = e.from;
    if (changed.some((c) => c === from || c.startsWith(from.endsWith('/') ? from : `${from}/`))) {
      return true;
    }
  }
  return false;
}

// 影響集合 = changed ∪ 逆依存の推移閉包（BFS）。graph: Map<file, string[]>（file → そのファイルを import しているファイル群）。
// 戻り値: { impacted: Set<string>, via: Map<string, string> }（via: 到達ファイル → 経路説明 "起点→...→終点"）
export function computeImpactSet(changed, graph) {
  const impacted = new Set(changed);
  const via = new Map(); // dep-closure で到達したファイル → 経路文字列
  if (!graph) return { impacted, via };
  for (const start of changed) {
    const cameFrom = new Map(); // node → parent（経路復元用）
    const queue = [start];
    const seen = new Set([start]);
    while (queue.length) {
      const cur = queue.shift();
      const dependents = graph.get(cur) || [];
      for (const dep of dependents) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        cameFrom.set(dep, cur);
        if (!impacted.has(dep)) {
          impacted.add(dep);
          // 経路復元: dep から start まで cameFrom を遡る
          const path = [dep];
          let node = dep;
          while (cameFrom.has(node)) {
            node = cameFrom.get(node);
            path.push(node);
          }
          path.reverse();
          if (!via.has(dep)) via.set(dep, path.join('→'));
        }
        queue.push(dep);
      }
    }
  }
  return { impacted, via };
}

// selectRubrics({ changed, graph, rubrics, explicit }) → { fired: [{id, rule, via?}], notRun: [id...] }
//   changed: string[]（変更ファイルパス群）
//   graph: Map<file, string[]> | null（file → 逆依存ファイル群。null/undefined なら dep-closure は空扱い）
//   rubrics: [{ id, scope, invariant?, edges? }]
//   explicit: string[] | undefined（明示指定 id 列。指定時は id が一致する rubric のみ発火・規則 'explicit'）
export function selectRubrics({ changed = [], graph = null, rubrics = [], explicit } = {}) {
  if (Array.isArray(explicit) && explicit.length) {
    const fired = [];
    const notRun = [];
    for (const r of rubrics) {
      if (explicit.includes(r.id)) fired.push({ id: r.id, rule: 'explicit' });
      else notRun.push(r.id);
    }
    return { fired, notRun };
  }

  const { impacted, via } = computeImpactSet(changed, graph);
  const impactedList = [...impacted];

  const fired = [];
  const notRun = [];
  for (const r of rubrics) {
    // 上位集合性: 旧規則（scope ∩ changed の prefix 照合）が発火するなら必ず direct-scope で fired に含める。
    if (scopeCoversAny(r.scope, changed)) {
      fired.push({ id: r.id, rule: 'direct-scope' });
      continue;
    }
    if (r.invariant === true) {
      fired.push({ id: r.id, rule: 'invariant' });
      continue;
    }
    if (declaredEdgeHit(r, changed)) {
      fired.push({ id: r.id, rule: 'declared-edge' });
      continue;
    }
    if (scopeCoversAny(r.scope, impactedList)) {
      // dep-closure: scope に触れた影響集合ファイルのうち、経路情報を持つ（= changed 自身でない）ものを選ぶ。
      const hit = (r.scope || []).flatMap((s) =>
        impactedList.filter((t) => (t === s || t.startsWith(s.endsWith('/') ? s : `${s}/`)) && via.has(t))
      );
      const viaPath = hit.length ? via.get(hit[0]) : undefined;
      fired.push({ id: r.id, rule: 'dep-closure', ...(viaPath ? { via: viaPath } : {}) });
      continue;
    }
    notRun.push(r.id);
  }
  return { fired, notRun };
}

// --- グラフ構築（CLI 実行環境向け・golden test の対象外） ---

// depcruise の JSON 出力から Map<file, string[]>（file → dependents＝逆依存）を構築する。
// changed が apps/web / packages に 1 つも触れない場合は null を返す（グラフ構築を省略＝Stop hook --quick の即時性）。
const DEPCRUISE_TARGETS = [
  'apps/web/app',
  'apps/web/components',
  'apps/web/lib',
  'apps/web/scripts',
  'packages/domain/src',
  'packages/mcp/src',
  'packages/acp-client/src',
  'packages/shared/src',
  'packages/client/src',
];

export function buildReverseGraph(changed, { cwd = process.cwd(), configPath = '.dependency-cruiser.js' } = {}) {
  const touchesGraphScope = (changed || []).some((c) => c.startsWith('apps/web/') || c.startsWith('packages/'));
  if (!touchesGraphScope) return null;

  const cmd = `pnpm exec depcruise --config ${configPath} --output-type json ${DEPCRUISE_TARGETS.join(' ')}`;
  let raw;
  try {
    raw = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 5e7 });
  } catch (e) {
    // depcruise は forbidden ルール違反時に非ゼロ exit を返すことがあるが、JSON は stdout に出る。
    raw = e.stdout || '';
    if (!raw) throw new Error(`depcruise 実行失敗（stdout 空）: ${e.message}`);
  }
  const parsed = JSON.parse(raw);
  const graph = new Map();
  for (const m of parsed.modules || []) {
    graph.set(m.source, Array.isArray(m.dependents) ? m.dependents : []);
  }
  return graph;
}

// --- CLI（直接実行時のみ。動作確認用の最小 CLI） ---
import { fileURLToPath, pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const changed = process.argv.slice(2);
  const graph = buildReverseGraph(changed);
  console.log(JSON.stringify({ changedCount: changed.length, graphSize: graph ? graph.size : 0 }, null, 2));
}
