// inner-loop-projects.mjs — GitHub Projects V2 status query / mutation helpers.
//
// ADR 0035 §7: project #2 (PVT_kwHOBH34q84Bcgbt) is the canonical kanban for
// all issues. Ready in Projects = PdM-approved for implementation. Driver
// writes In progress on start and In review on PR creation (non-fatal). Queue
// checks Ready status only for needs-review-labelled issues.
//
// Pure helpers are exported separately so unit tests can exercise them without
// side effects. Side-effect helpers (queryProjectItem / updateProjectItemStatus)
// take a `deps` injection point for spawnSync.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// --- Constants (ADR 0035 §7 参照節) ---

export const PROJECTS_PROJECT_ID = 'PVT_kwHOBH34q84Bcgbt';
export const PROJECTS_FIELD_ID = 'PVTSSF_lAHOBH34q84BcgbtzhXItAg';

/** Status field single-select option ids. */
export const PROJECTS_STATUS_OPTIONS = Object.freeze({
  Backlog: 'f75ad846',
  Ready: '61e4505c',
  InProgress: '47fc9ee4',
  InReview: 'df73e18b',
  Done: '98236657',
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
 * Extract the Status optionId from a ProjectV2ItemFieldSingleSelectValue.
 * @param {object | null | undefined} fieldValue
 * @returns {string | null}
 */
export function extractStatusOptionId(fieldValue) {
  if (!fieldValue || typeof fieldValue !== 'object') return null;
  return typeof fieldValue.optionId === 'string' ? fieldValue.optionId : null;
}

/**
 * Returns true when optionId matches the Ready status (ADR 0035 §3).
 * @param {string | null | undefined} optionId
 * @returns {boolean}
 */
export function isReadyOptionId(optionId) {
  return optionId === PROJECTS_STATUS_OPTIONS.Ready;
}

// --- GraphQL query / mutation strings ---

const ITEM_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      projectItems(first: 10) {
        nodes {
          id
          project { id }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { optionId }
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
 * Query the project item for an issue. Returns the item node id and Status
 * optionId (null when the issue is not in the project).
 * @param {number} issueNumber
 * @param {{ spawnSync?: Function, cwd?: string }} deps
 * @returns {{ ok: true, itemId: string | null, optionId: string | null } | { ok: false, reason: string }}
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
  if (!item) return { ok: true, itemId: null, optionId: null };
  return {
    ok: true,
    itemId: item.id,
    optionId: extractStatusOptionId(item.fieldValueByName ?? null),
  };
}

/**
 * Non-fatal Projects V2 status update (ADR 0035 §7: 正本は導出・書き込み失敗は
 * warning のみ). Queries the item id then writes the new status; silently
 * continues on any failure.
 * @param {number} issueNumber
 * @param {string} optionId  one of PROJECTS_STATUS_OPTIONS.*
 * @param {string} label  human-readable status name for log messages
 * @param {{ spawnSync?: Function, cwd?: string, log?: (msg:string)=>void }} deps
 */
export function trySetProjectStatus(issueNumber, optionId, label, deps = {}) {
  const logFn = deps.log ?? (() => {});
  const qi = queryProjectItem(issueNumber, deps);
  if (!qi.ok) { logFn(`warning: Projects query failed for #${issueNumber} (${label}): ${qi.reason}`); return; }
  if (!qi.itemId) { logFn(`warning: issue #${issueNumber} is not in project — skipping ${label} status update`); return; }
  const mu = updateProjectItemStatus(qi.itemId, optionId, deps);
  if (!mu.ok) { logFn(`warning: Projects status update failed for #${issueNumber} (${label}): ${mu.reason}`); }
  else { logFn(`projects: #${issueNumber} status → ${label}`); }
}

/**
 * Update the Status field for a project item. Non-fatal — caller logs a
 * warning on failure and continues (正本は導出, ADR 0035 §7).
 * @param {string} itemId
 * @param {string} optionId
 * @param {{ spawnSync?: Function, cwd?: string }} deps
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function updateProjectItemStatus(itemId, optionId, deps = {}) {
  const run = deps.spawnSync ?? spawnSync;
  const cwd = deps.cwd ?? REPO_ROOT;
  const r = run('gh', [
    'api', 'graphql',
    '-f', `query=${STATUS_MUTATION}`,
    '-f', `projectId=${PROJECTS_PROJECT_ID}`,
    '-f', `itemId=${itemId}`,
    '-f', `fieldId=${PROJECTS_FIELD_ID}`,
    '-f', `optionId=${optionId}`,
  ], { cwd, encoding: 'utf8', maxBuffer: 1e7 });
  if (r.status !== 0) {
    return { ok: false, reason: (r.stderr || r.stdout || 'gh api graphql mutation failed').slice(0, 500) };
  }
  return { ok: true };
}
