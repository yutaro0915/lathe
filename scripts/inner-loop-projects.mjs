// inner-loop-projects.mjs — GitHub Projects V2 status query / mutation helpers.
//
// ADR 0035 §7: project #2 (PVT_kwHOBH34q84Bcgbt) is the canonical kanban for
// all issues. Ready in Projects = PdM-approved for implementation. Driver
// writes In progress on start and In review on PR creation (non-fatal). Queue
// checks Ready status only for needs-review-labelled issues.
//
// Status field/option ids are resolved BY NAME at runtime (#201 分解 5): the
// 2026-07-07 incident showed that rebuilding the board columns regenerates
// every option id, so hard-coded ids silently kill Ready detection and status
// projection. Resolution runs once per process pass (success is cached) and
// any failure degrades to skipping the projection (non-fatal, ADR 0035 §7
// 正本は導出).
//
// Pure helpers are exported separately so unit tests can exercise them without
// side effects. Side-effect helpers take a `deps` injection point for spawnSync.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// --- Constants (ADR 0035 §7 参照節) ---

export const PROJECTS_PROJECT_ID = 'PVT_kwHOBH34q84Bcgbt';
export const PROJECTS_STATUS_FIELD_NAME = 'Status';

/** Status column NAMES (the stable contract — ids are resolved at runtime).
 * Renaming a board column is a deliberate schema change; regenerating ids
 * (column add/rebuild) is not, and must not break the driver (#201). */
export const PROJECTS_STATUS_NAMES = Object.freeze({
  Backlog: 'Backlog',
  Approval: 'Approval',
  Ready: 'Ready',
  InProgress: 'In progress',
  InReview: 'In review',
  Escalated: 'Escalated',
  Done: 'Done',
});

const REPO_OWNER = 'yutaro0915';
const REPO_NAME = 'lathe';

// --- Pure helpers ---

/**
 * Find the project item node ID for an issue in the configured project.
 * Returns null when the issue is not part of the project.
 * @param {Array<{ id: string, project?: { id: string }, fieldValueByName?: object | null }>} projectItemNodes
 * @returns {string | null}
 */
export function findProjectItemId(projectItemNodes) {
  const item = (projectItemNodes ?? []).find((n) => n?.project?.id === PROJECTS_PROJECT_ID);
  return item?.id ?? null;
}

/**
 * Extract the Status option NAME from a ProjectV2ItemFieldSingleSelectValue.
 * @param {object | null | undefined} fieldValue
 * @returns {string | null}
 */
export function extractStatusName(fieldValue) {
  if (!fieldValue || typeof fieldValue !== 'object') return null;
  return typeof fieldValue.name === 'string' ? fieldValue.name : null;
}

/**
 * Returns true when the status name is the Ready column (ADR 0035 §3).
 * @param {string | null | undefined} statusName
 * @returns {boolean}
 */
export function isReadyStatusName(statusName) {
  return statusName === PROJECTS_STATUS_NAMES.Ready;
}

/**
 * Parse the Status single-select field (id + option name→id map) out of the
 * STATUS_FIELD_QUERY response. Pure — returns null when the shape is missing.
 * @param {object | null | undefined} data  parsed gh api graphql JSON
 * @returns {{ fieldId: string, optionsByName: Record<string, string> } | null}
 */
export function parseStatusField(data) {
  const field = data?.data?.node?.field;
  if (!field || typeof field.id !== 'string' || !Array.isArray(field.options)) return null;
  const optionsByName = {};
  for (const option of field.options) {
    if (typeof option?.name === 'string' && typeof option?.id === 'string') {
      optionsByName[option.name] = option.id;
    }
  }
  return { fieldId: field.id, optionsByName };
}

// --- GraphQL query / mutation strings ---

const STATUS_FIELD_QUERY = `query($projectId: ID!, $fieldName: String!) {
  node(id: $projectId) {
    ... on ProjectV2 {
      field(name: $fieldName) {
        ... on ProjectV2SingleSelectField {
          id
          options { id name }
        }
      }
    }
  }
}`;

const ITEM_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $fieldName: String!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      projectItems(first: 10) {
        nodes {
          id
          project { id }
          fieldValueByName(name: $fieldName) {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}`;

const STATUS_MUTATION = `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item { id }
  }
}`;

// --- Side-effect helpers ---

/**
 * Resolve the Status field id and option name→id map by name via GraphQL.
 * @param {{ spawnSync?: Function, cwd?: string }} deps
 * @returns {{ ok: true, fieldId: string, optionsByName: Record<string, string> } | { ok: false, reason: string }}
 */
export function resolveStatusField(deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const cwd = deps.cwd ?? REPO_ROOT;
  const r = run('gh', [
    'api', 'graphql',
    '-f', `query=${STATUS_FIELD_QUERY}`,
    '-f', `projectId=${PROJECTS_PROJECT_ID}`,
    '-f', `fieldName=${PROJECTS_STATUS_FIELD_NAME}`,
  ], { cwd, encoding: 'utf8', maxBuffer: 1e7 });
  if (r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.stdout || 'gh api graphql failed').slice(0, 500) };
  }
  let data;
  try { data = JSON.parse(r.stdout); } catch (e) {
    return { ok: false, reason: `JSON parse error: ${e.message}` };
  }
  const parsed = parseStatusField(data);
  if (!parsed) return { ok: false, reason: `could not resolve field "${PROJECTS_STATUS_FIELD_NAME}" (single-select) on project ${PROJECTS_PROJECT_ID}` };
  return { ok: true, ...parsed };
}

// 1 パス 1 回 (#201 分解 5): the resolved field/options are cached for the
// process lifetime. Only success is cached — a transient gh failure stays
// non-fatal (caller skips the projection) and may recover at the next call.
let statusFieldCache = null;

/** Cached name resolution (see above). @param {{ spawnSync?: Function, cwd?: string }} deps */
export function getStatusField(deps = {}) {
  if (statusFieldCache?.ok) return statusFieldCache;
  statusFieldCache = resolveStatusField(deps);
  return statusFieldCache;
}

export function resetStatusFieldCache() {
  statusFieldCache = null;
}

/**
 * Query the project item for an issue. Returns the item node id and Status
 * name (null when the issue is not in the project / has no status).
 * @param {number} issueNumber
 * @param {{ spawnSync?: Function, cwd?: string }} deps
 * @returns {{ ok: true, itemId: string | null, statusName: string | null } | { ok: false, reason: string }}
 */
export function queryProjectItem(issueNumber, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const cwd = deps.cwd ?? REPO_ROOT;
  const r = run('gh', [
    'api', 'graphql',
    '-f', `query=${ITEM_QUERY}`,
    '-f', `owner=${REPO_OWNER}`,
    '-f', `repo=${REPO_NAME}`,
    '-F', `number=${issueNumber}`,
    '-f', `fieldName=${PROJECTS_STATUS_FIELD_NAME}`,
  ], { cwd, encoding: 'utf8', maxBuffer: 1e7 });
  if (r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.stdout || 'gh api graphql failed').slice(0, 500) };
  }
  let data;
  try { data = JSON.parse(r.stdout); } catch (e) {
    return { ok: false, reason: `JSON parse error: ${e.message}` };
  }
  const nodes = data?.data?.repository?.issue?.projectItems?.nodes ?? [];
  const item = nodes.find((n) => n?.project?.id === PROJECTS_PROJECT_ID);
  if (!item) return { ok: true, itemId: null, statusName: null };
  return {
    ok: true,
    itemId: item.id,
    statusName: extractStatusName(item.fieldValueByName ?? null),
  };
}

/**
 * Non-fatal Projects V2 status update (ADR 0035 §7: 正本は導出・書き込み失敗は
 * warning のみ). Resolves the Status field/option ids by name (cached per
 * pass), queries the item id, then writes the new status; silently continues
 * on any failure.
 * @param {number} issueNumber
 * @param {string} statusName  one of PROJECTS_STATUS_NAMES.* (column name)
 * @param {{ spawnSync?: Function, cwd?: string, log?: (msg:string)=>void }} deps
 */
export function trySetProjectStatus(issueNumber, statusName, deps = {}) {
  const logFn = deps.log ?? (() => {});
  const field = getStatusField(deps);
  if (!field.ok) { logFn(`warning: Projects Status field resolution failed for #${issueNumber} (${statusName}): ${field.reason} — skipping projection`); return; }
  const optionId = field.optionsByName[statusName];
  if (!optionId) { logFn(`warning: Projects Status option "${statusName}" not found on the board (have: ${Object.keys(field.optionsByName).join(', ')}) — skipping projection for #${issueNumber}`); return; }
  const qi = queryProjectItem(issueNumber, deps);
  if (!qi.ok) { logFn(`warning: Projects query failed for #${issueNumber} (${statusName}): ${qi.reason}`); return; }
  if (!qi.itemId) { logFn(`warning: issue #${issueNumber} is not in project — skipping ${statusName} status update`); return; }
  const mu = updateProjectItemStatus(qi.itemId, { fieldId: field.fieldId, optionId }, deps);
  if (!mu.ok) { logFn(`warning: Projects status update failed for #${issueNumber} (${statusName}): ${mu.reason}`); }
  else { logFn(`projects: #${issueNumber} status → ${statusName}`); }
}

/**
 * Update the Status field for a project item. Non-fatal — caller logs a
 * warning on failure and continues (正本は導出, ADR 0035 §7).
 * @param {string} itemId
 * @param {{ fieldId: string, optionId: string }} target  resolved by getStatusField
 * @param {{ spawnSync?: Function, cwd?: string }} deps
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function updateProjectItemStatus(itemId, { fieldId, optionId }, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const cwd = deps.cwd ?? REPO_ROOT;
  const r = run('gh', [
    'api', 'graphql',
    '-f', `query=${STATUS_MUTATION}`,
    '-f', `projectId=${PROJECTS_PROJECT_ID}`,
    '-f', `itemId=${itemId}`,
    '-f', `fieldId=${fieldId}`,
    '-f', `optionId=${optionId}`,
  ], { cwd, encoding: 'utf8', maxBuffer: 1e7 });
  if (r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.stdout || 'gh api graphql mutation failed').slice(0, 500) };
  }
  return { ok: true };
}
