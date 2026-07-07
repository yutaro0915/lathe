#!/usr/bin/env node
// CLI (debug): node scripts/orchestrator-derive.mjs   — 正規化 snapshot を JSON で表示
// orchestrator-derive.mjs — gh から orchestrator の全入力状態を 1 パスで導出する
// snapshot 層（#201 分解 7）。open issues＋labels＋Projects Status＋open PRs＋
// review 記録の有無＋教材の有無（done-explain label）を 1 回の GraphQL バッチで
// 取り、正規化して返す。保存しない（ADR 0031 §2: state is derived, never stored）。
//
// Status option id はハードコードしない — パス冒頭に Status field の名前→id を
// GraphQL で名前解決する（#201 comment 2026-07-07 incident: 盤面列再構築で option
// id が全再生成され、id 直書き定数が stale 化して Ready 検出・投影が停止した）。
//
// 純関数（normalize / ref 収集 / query 組み立て）と side effect（gh api graphql）を
// 分離。blocked-by が open issue 集合の外を指すときだけ、その参照 issue の state を
// 2 本目のバッチ query で解決する（失敗時は fail-closed = open 扱い＝dispatch しない）。

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { parseBlockedBy } from './inner-loop-core.mjs';
import { hasReviewRecord } from './review-engine.mjs';
import { PROJECTS_PROJECT_ID } from './inner-loop-projects.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// リポジトリ座標。inner-loop-projects.mjs も同値を private に持つが export されて
// おらず、既存 driver ファイルは並行 wave（Wave1-A）編集中のためここで再宣言する。
export const REPO_OWNER = 'yutaro0915';
export const REPO_NAME = 'lathe';

const PAGE_SIZE = 100;

// --- GraphQL query（1 バッチ: Status field 名前解決＋open issues＋open PRs） ---

export const SNAPSHOT_QUERY = `query($owner: String!, $repo: String!, $projectId: ID!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      field(name: "Status") {
        ... on ProjectV2SingleSelectField { id name options { id name } }
      }
    }
  }
  repository(owner: $owner, name: $repo) {
    issues(states: OPEN, first: ${PAGE_SIZE}) {
      pageInfo { hasNextPage }
      nodes {
        number title body
        labels(first: 30) { nodes { name } }
        projectItems(first: 10) {
          nodes {
            id
            project { id }
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { optionId name }
            }
          }
        }
      }
    }
    pullRequests(states: OPEN, first: ${PAGE_SIZE}) {
      pageInfo { hasNextPage }
      nodes {
        number title body isDraft headRefName url
        comments(last: 100) { nodes { body } }
        reviews(last: 100) { nodes { body } }
      }
    }
  }
}`;

// --- Pure helpers ---

/**
 * driver 産 PR（`inner/issue-<n>` head branch, worktreeNameFor 命名）か。
 * @param {string | null | undefined} headRefName
 * @returns {boolean}
 */
export function isDriverPrBranch(headRefName) {
  return /^inner\/issue-\d+$/.test(String(headRefName ?? ''));
}

/**
 * ProjectV2 node から Status field を名前解決する。
 * 解決不能なら null（呼び出し側で fail-closed に扱う）。
 * @param {object | null | undefined} projectNode  SNAPSHOT_QUERY の node(id: $projectId)
 * @returns {{ fieldId: string, options: Object<string, string> } | null}
 */
export function resolveStatusField(projectNode) {
  const field = projectNode?.field ?? null;
  if (!field || typeof field.id !== 'string' || !Array.isArray(field.options)) return null;
  const options = {};
  for (const opt of field.options) {
    if (typeof opt?.name === 'string' && typeof opt?.id === 'string') options[opt.name] = opt.id;
  }
  return { fieldId: field.id, options };
}

/**
 * GraphQL issue node → IssueState。statusName / projectItemId は project #2
 * （PROJECTS_PROJECT_ID）の item から取る（他 project の item は無視）。
 * @param {object} node
 * @returns {{ number: number, title: string, body: string, labels: string[],
 *   blockedBy: number[], projectItemId: string | null, statusName: string | null }}
 */
export function normalizeIssue(node) {
  const labels = (node?.labels?.nodes ?? [])
    .map((l) => l?.name)
    .filter((name) => typeof name === 'string' && name.length > 0);
  const item = (node?.projectItems?.nodes ?? [])
    .find((n) => n?.project?.id === PROJECTS_PROJECT_ID) ?? null;
  const fieldValue = item?.fieldValueByName ?? null;
  const body = node?.body ?? '';
  return {
    number: node.number,
    title: node?.title ?? '',
    body,
    labels,
    blockedBy: parseBlockedBy(body),
    projectItemId: item?.id ?? null,
    statusName: typeof fieldValue?.name === 'string' ? fieldValue.name : null,
  };
}

/**
 * GraphQL PR node → PrState。review 記録の有無は review-engine の判定
 * （engine marker または `## REVIEW:` heading）をそのまま使う。
 * @param {object} node
 * @returns {{ number: number, title: string, body: string, isDraft: boolean,
 *   headRefName: string, url: string, isDriverPr: boolean, hasReviewRecord: boolean }}
 */
export function normalizePr(node) {
  return {
    number: node.number,
    title: node?.title ?? '',
    body: node?.body ?? '',
    isDraft: node?.isDraft === true,
    headRefName: node?.headRefName ?? '',
    url: node?.url ?? '',
    isDriverPr: isDriverPrBranch(node?.headRefName),
    hasReviewRecord: hasReviewRecord({
      comments: node?.comments?.nodes ?? [],
      reviews: node?.reviews?.nodes ?? [],
    }),
  };
}

/**
 * @typedef {ReturnType<typeof normalizeIssue>} IssueState
 * @typedef {ReturnType<typeof normalizePr>} PrState
 * @typedef {{ statusField: { fieldId: string, options: Object<string, string> } | null,
 *   issues: IssueState[], prs: PrState[], openBlockerRefs: number[], warnings: string[] }} OrchestratorSnapshot
 */

/**
 * SNAPSHOT_QUERY の data → 正規化 snapshot。openBlockerRefs（open issue 集合外の
 * open な blocked-by 参照）は deriveSnapshot が 2 本目の query で埋める。
 * @param {object | null | undefined} data
 * @returns {OrchestratorSnapshot}
 */
export function normalizeSnapshot(data) {
  const warnings = [];
  const statusField = resolveStatusField(data?.node ?? null);
  if (!statusField) {
    warnings.push('Status field を名前解決できない — Ready 検出と盤面投影は fail-closed で停止');
  }
  const issuesConn = data?.repository?.issues;
  const prsConn = data?.repository?.pullRequests;
  if (issuesConn?.pageInfo?.hasNextPage) warnings.push(`open issues が 1 ページ（${PAGE_SIZE}）を超過 — snapshot は先頭ページのみ`);
  if (prsConn?.pageInfo?.hasNextPage) warnings.push(`open PRs が 1 ページ（${PAGE_SIZE}）を超過 — snapshot は先頭ページのみ`);
  const issues = (issuesConn?.nodes ?? [])
    .filter((n) => n && Number.isInteger(n.number))
    .map(normalizeIssue)
    .sort((a, b) => a.number - b.number);
  const prs = (prsConn?.nodes ?? [])
    .filter((n) => n && Number.isInteger(n.number))
    .map(normalizePr)
    .sort((a, b) => a.number - b.number);
  return { statusField, issues, prs, openBlockerRefs: [], warnings };
}

/**
 * open issue 集合の外を指す blocked-by 参照を昇順で集める。
 * @param {IssueState[]} issues
 * @returns {number[]}
 */
export function collectOutsideRefs(issues) {
  const open = new Set((issues ?? []).map((i) => i.number));
  const outside = new Set();
  for (const issue of issues ?? []) {
    for (const ref of issue.blockedBy) if (!open.has(ref)) outside.add(ref);
  }
  return [...outside].sort((a, b) => a - b);
}

/**
 * 集合外 blocked-by 参照の state をまとめて引く aliased バッチ query。
 * @param {number[]} refs
 * @returns {string}
 */
export function buildRefStatesQuery(refs) {
  const fields = (refs ?? []).map((n) => `r${n}: issue(number: ${n}) { number state }`).join(' ');
  return `query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { ${fields} } }`;
}

/**
 * buildRefStatesQuery の data → open な参照の配列。見つからない参照（削除・移管等で
 * node が null）は open 扱い（fail-closed: 依存解決済みと誤認して dispatch しない）。
 * @param {object | null | undefined} data
 * @param {number[]} refs
 * @returns {number[]}
 */
export function parseRefStates(data, refs) {
  const open = [];
  for (const n of refs ?? []) {
    const node = data?.repository?.[`r${n}`];
    const state = String(node?.state ?? 'OPEN').toUpperCase();
    if (state === 'OPEN') open.push(n);
  }
  return open;
}

// --- Side effects（gh api graphql・deps 注入可） ---

function ghGraphql(query, vars, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(vars)) args.push('-f', `${key}=${value}`);
  const r = run('gh', args, { cwd: deps.cwd ?? REPO_ROOT, encoding: 'utf8', maxBuffer: 1e8 });
  if (r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.stdout || 'gh api graphql failed').slice(0, 500) };
  }
  try {
    return { ok: true, data: JSON.parse(r.stdout)?.data ?? null };
  } catch (e) {
    return { ok: false, reason: `JSON parse error: ${e.message}` };
  }
}

/**
 * 全状態を導出する（保存しない）。GraphQL 2 リクエスト以内:
 * ①snapshot バッチ ②集合外 blocked-by 参照の state（あるときだけ）。
 * @param {{ spawnSync?: Function, cwd?: string }} deps
 * @returns {{ ok: true, snapshot: OrchestratorSnapshot } | { ok: false, reason: string }}
 */
export function deriveSnapshot(deps = {}) {
  const main = ghGraphql(SNAPSHOT_QUERY, {
    owner: REPO_OWNER, repo: REPO_NAME, projectId: PROJECTS_PROJECT_ID,
  }, deps);
  if (!main.ok) return { ok: false, reason: `snapshot query failed: ${main.reason}` };
  const snapshot = normalizeSnapshot(main.data);

  const outside = collectOutsideRefs(snapshot.issues);
  if (outside.length > 0) {
    const refs = ghGraphql(buildRefStatesQuery(outside), { owner: REPO_OWNER, repo: REPO_NAME }, deps);
    if (refs.ok) {
      snapshot.openBlockerRefs = parseRefStates(refs.data, outside);
    } else {
      snapshot.openBlockerRefs = outside;
      snapshot.warnings.push(
        `blocked-by 参照の state query が失敗（${refs.reason}）— 集合外 ${outside.length} 件を open 扱い（fail-closed）`,
      );
    }
  }
  return { ok: true, snapshot };
}

// --- CLI（debug 用: 正規化 snapshot を表示するだけ・書き込みなし） ---

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const result = deriveSnapshot();
  if (!result.ok) {
    process.stderr.write(`orchestrator-derive: error: ${result.reason}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(result.snapshot, null, 2)}\n`);
}
