import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRunManifestCostReport,
  formatJson,
  formatMarkdown,
  makeUnavailableReport,
} from './run-manifest-cost-report';

type QueryCall = { sql: string; params?: unknown[] };

function manifest(stages: unknown[]): string {
  return JSON.stringify({ issue: 34, stages });
}

function approx(actual: number | null, expected: number): void {
  assert.equal(typeof actual, 'number');
  assert.ok(Math.abs((actual as number) - expected) < 0.000001, `${actual} !== ${expected}`);
}

describe('run-manifest-cost-report', () => {
  it('separates DB session cost from backend envelope cost and child diagnostics', async () => {
    const calls: QueryCall[] = [];
    const report = await buildRunManifestCostReport({
      manifestPath: '/tmp/issue-34.json',
      deps: {
        now: () => new Date('2026-07-02T00:00:00.000Z'),
        readFile: () => manifest([
          {
            stage: 'IMPLEMENT',
            session_id: 's-impl',
            verdict: 'IMPL_DONE',
            backend: 'claude',
            backend_cost_usd: 0.72,
            backend_cost_source: 'claude.result.total_cost_usd',
          },
        ]),
        queryRows: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
          calls.push(params === undefined ? { sql } : { sql, params });
          if (sql.includes('parent_session_id')) {
            return [{ session_id: 's-impl', cost_usd: 0.4, child_count: 2 }] as T[];
          }
          if (sql.includes('transcript_events')) {
            return [{ session_id: 's-impl', cost_usd: 0.2, launcher_count: 1 }] as T[];
          }
          return [{ id: 's-impl', cost_usd: 2.03 }] as T[];
        },
      },
    });

    assert.equal(report.status, 'ok');
    assert.equal(calls.length, 3);
    const stage = report.stages[0];
    assert.equal(stage.stage_session_cost_usd, 2.03);
    assert.equal(stage.stage_session_cost_source, 'db.sessions.cost_usd');
    assert.equal(stage.backend_cost_usd, 0.72);
    assert.equal(stage.backend_cost_source, 'claude.result.total_cost_usd');
    assert.equal(stage.legacy_backend_cost_usd, null);
    assert.equal(stage.linked_child_sessions_cost_usd, 0.4);
    assert.equal(stage.linked_child_sessions_count, 2);
    assert.equal(stage.launcher_meta_subagent_cost_usd, 0.2);
    assert.equal(stage.launcher_meta_subagent_count, 1);
    approx(stage.delta_backend_vs_db_session_usd, -1.31);
    approx(stage.ratio_backend_vs_db_session, 0.72 / 2.03);
  });

  it('labels legacy manifest cost_usd as backend/envelope cost', async () => {
    const report = await buildRunManifestCostReport({
      manifestPath: '/tmp/issue-29.json',
      deps: {
        now: () => new Date('2026-07-02T00:00:00.000Z'),
        readFile: () => manifest([
          {
            stage: 'PLAN',
            session_id: 's-plan',
            verdict: 'PLAN_READY',
            backend: 'claude',
            cost_usd: 0.72,
          },
        ]),
        queryRows: async <T>(sql: string): Promise<T[]> => {
          if (sql.includes('parent_session_id') || sql.includes('transcript_events')) return [];
          return [{ id: 's-plan', cost_usd: 2.03 }] as T[];
        },
      },
    });

    assert.equal(report.status, 'ok');
    assert.equal(report.stages[0].backend_cost_usd, 0.72);
    assert.equal(report.stages[0].backend_cost_source, 'legacy_backend_cost_usd');
    assert.equal(report.stages[0].legacy_backend_cost_usd, 0.72);

    const markdown = formatMarkdown(report);
    assert.match(markdown, /stage_session_cost_source=db\.sessions\.cost_usd/);
    assert.match(markdown, /backend_cost_source=legacy_backend_cost_usd/);
    assert.match(markdown, /legacy_backend_cost_usd=\$0\.720000/);

    const json = formatJson(report);
    assert.match(json, /"status": "ok"/);
    assert.match(json, /"backend_cost_source": "legacy_backend_cost_usd"/);
  });

  it('marks stages missing from DB without failing the whole report', async () => {
    const report = await buildRunManifestCostReport({
      manifestPath: '/tmp/issue-34.json',
      deps: {
        readFile: () => manifest([
          {
            stage: 'VERIFY',
            session_id: 's-missing',
            verdict: 'GREEN',
            backend: 'codex',
            backend_cost_usd: 0.31,
            backend_cost_source: 'codex.jsonl.explicit_cost',
          },
        ]),
        queryRows: async () => [],
      },
    });

    assert.equal(report.status, 'ok');
    assert.equal(report.stages[0].db_status, 'missing');
    assert.equal(report.stages[0].stage_session_cost_usd, null);
    assert.equal(report.stages[0].stage_session_cost_source, null);
    assert.equal(report.stages[0].delta_backend_vs_db_session_usd, null);
  });

  it('returns unavailable when manifest or DB access fails', async () => {
    const dbUnavailable = await buildRunManifestCostReport({
      manifestPath: '/tmp/issue-34.json',
      deps: {
        readFile: () => manifest([{ stage: 'PLAN', session_id: 's1' }]),
        queryRows: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
    });

    assert.equal(dbUnavailable.status, 'unavailable');
    assert.match(dbUnavailable.reason, /connect ECONNREFUSED/);
    assert.match(formatMarkdown(dbUnavailable), /cost report unavailable: connect ECONNREFUSED/);

    const explicit = makeUnavailableReport('no manifest', new Date('2026-07-02T00:00:00.000Z'));
    assert.equal(explicit.status, 'unavailable');
    assert.equal(explicit.generatedAt, '2026-07-02T00:00:00.000Z');
  });
});
