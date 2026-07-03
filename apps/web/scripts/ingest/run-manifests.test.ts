import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  deriveRunManifestRows,
  discoverRunManifestFiles,
  findRepoRoot,
  parseRunKey,
} from './run-manifests';

function makeTmpRepo(name: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(path.join(repoRoot, '.git'), 'gitdir: /tmp/nonexistent\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'apps', 'web'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, '.lathe', 'runs'), { recursive: true });
  return repoRoot;
}

function writeManifest(repoRoot: string, fileName: string, manifest: unknown): string {
  const manifestPath = path.join(repoRoot, '.lathe', 'runs', fileName);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return manifestPath;
}

test('findRepoRoot: resolves repository root from apps/web cwd', () => {
  const repoRoot = makeTmpRepo('lathe-root');
  try {
    assert.equal(findRepoRoot(path.join(repoRoot, 'apps', 'web')), repoRoot);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('parseRunKey: preserves issue, plan, and attempt run keys', () => {
  assert.equal(parseRunKey('/repo/.lathe/runs/issue-25.json'), 'issue-25');
  assert.equal(parseRunKey('/repo/.lathe/runs/issue-25.attempt1.json'), 'issue-25.attempt1');
  assert.equal(parseRunKey('/repo/.lathe/runs/plan-43.json'), 'plan-43');
});

test('discoverRunManifestFiles: returns only json manifests from .lathe/runs', () => {
  const repoRoot = makeTmpRepo('lathe-runs');
  try {
    writeManifest(repoRoot, 'issue-25.json', { issue: 25, stages: [] });
    writeManifest(repoRoot, 'issue-25.attempt1.json', { issue: 25, stages: [] });
    fs.writeFileSync(path.join(repoRoot, '.lathe', 'runs', 'issue-25.escalation.md'), 'x', 'utf8');

    assert.deepEqual(
      discoverRunManifestFiles(repoRoot).map((file) => path.basename(file)),
      ['issue-25.attempt1.json', 'issue-25.json'],
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('deriveRunManifestRows: scopes same run_key by project and preserves nullable/legacy fields', () => {
  const repoA = makeTmpRepo('lathe-project-a');
  const repoB = makeTmpRepo('lathe-project-b');
  try {
    const manifestAPath = writeManifest(repoA, 'issue-23.json', {
      issue: 23,
      stages: [
        {
          stage: 'PLAN',
          session_id: null,
          verdict: 'PLAN_READY',
          backend: null,
          backend_model: null,
          head_sha: null,
          duration_ms: null,
          ts: '2026-07-03T00:00:00.000Z',
          skipped: true,
          cost_usd: 0.12,
          backend_token_usage: { input_tokens: 10 },
        },
        {
          stage: 'IMPLEMENT',
          session_id: 's-impl',
          verdict: 'ESCALATE',
          backend: 'codex',
          backend_model: 'gpt-test',
          head_sha: 'abc123',
          duration_ms: 321,
          ts: '2026-07-03T00:01:00.000Z',
          backend_cost_usd: 0.34,
          backend_cost_source: 'codex.jsonl.explicit_cost',
        },
      ],
    });
    const manifestBPath = writeManifest(repoB, 'issue-23.json', {
      issue: 23,
      stages: [{ stage: 'PLAN', session_id: 's-plan-b', verdict: null }],
    });
    fs.writeFileSync(path.join(repoA, '.lathe', 'runs', 'issue-23.escalation.md'), '# escalation\n', 'utf8');

    const rowsA = deriveRunManifestRows({
      repoRoot: repoA,
      projectId: 'project:a',
      manifestPath: manifestAPath,
    });
    const rowsB = deriveRunManifestRows({
      repoRoot: repoB,
      projectId: 'project:b',
      manifestPath: manifestBPath,
    });

    assert.equal(rowsA.run.projectId, 'project:a');
    assert.equal(rowsB.run.projectId, 'project:b');
    assert.equal(rowsA.run.runKey, 'issue-23');
    assert.equal(rowsB.run.runKey, 'issue-23');
    assert.equal(rowsA.run.loopKind, 'issue');
    assert.equal(rowsA.run.sourceIssueNumber, 23);
    assert.equal(rowsA.run.stageCount, 2);
    assert.equal(rowsA.run.lastStage, 'IMPLEMENT');
    assert.equal(rowsA.run.lastVerdict, 'ESCALATE');
    assert.equal(rowsA.run.hasEscalation, true);
    assert.equal(rowsA.run.escalationPath, '.lathe/runs/issue-23.escalation.md');
    assert.equal(rowsA.run.manifestPath, '.lathe/runs/issue-23.json');
    assert.match(rowsA.run.manifestSha256, /^[a-f0-9]{64}$/);

    assert.equal(rowsA.stages.length, 2);
    assert.equal(rowsA.stages[0].stageIndex, 0);
    assert.equal(rowsA.stages[0].sessionId, null);
    assert.equal(rowsA.stages[0].backend, null);
    assert.equal(rowsA.stages[0].verdict, 'PLAN_READY');
    assert.equal(rowsA.stages[0].skipped, true);
    assert.equal(rowsA.stages[0].backendCostUsd, null);
    assert.equal(rowsA.stages[0].backendCostSource, null);
    assert.equal(rowsA.stages[0].legacyBackendCostUsd, 0.12);
    assert.deepEqual(rowsA.stages[0].backendTokenUsage, { input_tokens: 10 });

    assert.equal(rowsA.stages[1].stageIndex, 1);
    assert.equal(rowsA.stages[1].sessionId, 's-impl');
    assert.equal(rowsA.stages[1].backend, 'codex');
    assert.equal(rowsA.stages[1].backendModel, 'gpt-test');
    assert.equal(rowsA.stages[1].headSha, 'abc123');
    assert.equal(rowsA.stages[1].durationMs, 321);
    assert.equal(rowsA.stages[1].backendCostUsd, 0.34);
    assert.equal(rowsA.stages[1].backendCostSource, 'codex.jsonl.explicit_cost');
    assert.equal(rowsA.stages[1].legacyBackendCostUsd, null);
  } finally {
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  }
});
