// explain-publish.mjs — 決定的な Discussion 配信スクリプト（#300、親 #299）。
//
// 根因（#299）: 配信経路にスクリプトが無く runner が body 渡しフラグを即興していた。
// `gh api graphql` の `-f/--raw-field` は常に literal 文字列（`@` の file-read magic は
// `-F/--field` だけが持つ、`gh api --help` 実測）。runner が `-f body=@<path>` を使うと
// body は **リテラル文字列 "@<path>"** になる（file は読まれない）— これが「空の殻」の機構。
// 本モジュールは body の入口を 1 つに固定する: `resolveBody(file)` が readFileSync で
// 中身を取得し、その文字列を **常に `-f`（raw-field）で** graphql へ渡す。`-f` は `@` を
// 特別扱いしないため、教材の中身が偶然 `@` から始まっても literal のまま送られる
// （literal/from-file を切り替える optional 引数は作らない＝同一情報の入口は 1 つ）。
//
// create と comment は同じ resolveBody / ghGraphql / verifyPublishedBody を共有する。
// 外部 gh は deps 注入で純関数化（scripts/orchestrator-explain.mjs の deps 注入パターンに準拠）。
//
//   publishExplainDiscussion(input, deps) ─┐
//   addExplainComment(input, deps) ────────┤→ resolveBody(file)=readFileSync(file,'utf8')
//                                          └→ verifyPublishedBody(published, material)
//
// publish/comment 直後、mutation の応答（discussion.body / comment.body — GitHub 側が
// 実際に保存した値のサーバエコー）を self-check にかける。「空の殻」（空／`@explains` 始まり／
// 教材より短い）を検出したら ok:false を返す。

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './inner-loop-core.mjs';
import { REPO_OWNER, REPO_NAME } from './orchestrator-derive.mjs';

/** @typedef {{ issue:number, category:string, title:string, file:string }} PublishInput */
/** @typedef {{ discussionId:string, file:string }} CommentInput */
/** @typedef {{ ok:boolean, url?:string, reason?:string }} PublishResult */

const EMPTY_SHELL_PREFIX = '@explains';

// --- Pure helpers ---

/**
 * 唯一の body 入口。file の中身をそのまま返す — 呼び出し側は issue 番号・カテゴリ・
 * ファイルパスだけを渡し、本文文字列の生成・渡し方はここに閉じる。
 * @param {string} file
 * @param {{ readFileSync?: Function }} deps
 * @returns {string}
 */
export function resolveBody(file, deps = {}) {
  const read = deps.readFileSync ?? readFileSync;
  return read(file, 'utf8');
}

/**
 * publish/comment 直後の self-check（#300 の根因: `-f body=@<path>` の literal 渡しで
 * 本文が `@<path>` の 1 行になる「空の殻」事故を検出する）。
 * ok=false: 空 / `@explains` で始まる / 教材本体より短い。
 * @param {string} publishedBody
 * @param {string} materialBody
 * @returns {{ ok: boolean, reason?: string }}
 */
export function verifyPublishedBody(publishedBody, materialBody) {
  const published = String(publishedBody ?? '');
  const material = String(materialBody ?? '');
  if (published.length === 0) {
    return { ok: false, reason: 'published body is empty' };
  }
  if (published.startsWith(EMPTY_SHELL_PREFIX)) {
    return { ok: false, reason: `published body starts with "${EMPTY_SHELL_PREFIX}" — literal @path shell (#300)` };
  }
  if (published.length < material.length) {
    return { ok: false, reason: `published body shorter than material (${published.length} < ${material.length})` };
  }
  return { ok: true };
}

/**
 * category 名（大小無視）→ discussionCategories query の応答から categoryId を引く。
 * @param {object | null | undefined} data
 * @param {string} categoryName
 * @returns {string | null}
 */
export function findCategoryId(data, categoryName) {
  const nodes = data?.repository?.discussionCategories?.nodes ?? [];
  const match = nodes.find(
    (n) => String(n?.name ?? '').toLowerCase() === String(categoryName ?? '').toLowerCase(),
  );
  return match?.id ?? null;
}

// --- GraphQL queries/mutations ---

const REPOSITORY_CATEGORY_QUERY = 'query($owner: String!, $repo: String!) { '
  + 'repository(owner: $owner, name: $repo) { id discussionCategories(first: 25) { nodes { id name } } } }';

const CREATE_DISCUSSION_MUTATION = 'mutation($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) { '
  + 'createDiscussion(input: { repositoryId: $repositoryId, categoryId: $categoryId, title: $title, body: $body }) { '
  + 'discussion { id url body } } }';

const ADD_DISCUSSION_COMMENT_MUTATION = 'mutation($discussionId: ID!, $body: String!) { '
  + 'addDiscussionComment(input: { discussionId: $discussionId, body: $body }) { comment { id url body } } }';

// --- Side effects（gh api graphql・deps 注入可） ---

/**
 * `gh api graphql` 呼び出し。全 field は `-f`（raw-field=literal 文字列。`@` の
 * file-read magic を一切発火させない）で渡す — body に限らずここを唯一の graphql 入口にする。
 * @param {string} query
 * @param {Record<string, string>} vars
 * @param {{ spawnSync?: Function, cwd?: string }} deps
 * @returns {{ ok: true, data: object | null } | { ok: false, reason: string }}
 */
function ghGraphql(query, vars, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(vars ?? {})) args.push('-f', `${key}=${value}`);
  const r = run('gh', args, { cwd: deps.cwd ?? REPO_ROOT, encoding: 'utf8', maxBuffer: 1e8 });
  if (r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.stdout || 'gh api graphql failed').slice(0, 500) };
  }
  try {
    const parsed = JSON.parse(r.stdout);
    if (parsed?.errors?.length) {
      return { ok: false, reason: parsed.errors.map((e) => e.message).join('; ').slice(0, 500) };
    }
    return { ok: true, data: parsed?.data ?? null };
  } catch (e) {
    return { ok: false, reason: `JSON parse error: ${e.message}` };
  }
}

/**
 * 教材ファイルを新規 GitHub Discussion として publish する。
 * body の唯一の入口は resolveBody(file) — literal/from-file を切り替える引数はない。
 * publish 直後、mutation 応答の discussion.body（サーバエコー）を self-check にかける。
 * @param {PublishInput} input
 * @param {{ spawnSync?: Function, readFileSync?: Function, cwd?: string }} deps
 * @returns {PublishResult}
 */
export function publishExplainDiscussion(input, deps = {}) {
  const { issue, category, title, file } = input ?? {};
  const materialBody = resolveBody(file, deps);

  const repo = ghGraphql(REPOSITORY_CATEGORY_QUERY, { owner: REPO_OWNER, repo: REPO_NAME }, deps);
  if (!repo.ok) return { ok: false, reason: `repository/category query failed: ${repo.reason}` };

  const repositoryId = repo.data?.repository?.id;
  if (!repositoryId) return { ok: false, reason: 'repositoryId not found in repository/category query response' };

  const categoryId = findCategoryId(repo.data, category);
  if (!categoryId) return { ok: false, reason: `discussion category "${category}" not found` };

  const created = ghGraphql(CREATE_DISCUSSION_MUTATION, {
    repositoryId, categoryId, title, body: materialBody,
  }, deps);
  if (!created.ok) return { ok: false, reason: `createDiscussion failed: ${created.reason}` };

  const discussion = created.data?.createDiscussion?.discussion;
  const check = verifyPublishedBody(discussion?.body, materialBody);
  if (!check.ok) {
    return { ok: false, reason: `self-check failed for issue #${issue}: ${check.reason}` };
  }
  return { ok: true, url: discussion?.url };
}

/**
 * 既存 Discussion に教材ファイルを comment として追記する。
 * body の唯一の入口は resolveBody(file)。comment 直後、mutation 応答の comment.body
 * （サーバエコー）を self-check にかける。
 * @param {CommentInput} input
 * @param {{ spawnSync?: Function, readFileSync?: Function, cwd?: string }} deps
 * @returns {PublishResult}
 */
export function addExplainComment(input, deps = {}) {
  const { discussionId, file } = input ?? {};
  const materialBody = resolveBody(file, deps);

  const added = ghGraphql(ADD_DISCUSSION_COMMENT_MUTATION, { discussionId, body: materialBody }, deps);
  if (!added.ok) return { ok: false, reason: `addDiscussionComment failed: ${added.reason}` };

  const comment = added.data?.addDiscussionComment?.comment;
  const check = verifyPublishedBody(comment?.body, materialBody);
  if (!check.ok) {
    return { ok: false, reason: `self-check failed: ${check.reason}` };
  }
  return { ok: true, url: comment?.url };
}
