#!/usr/bin/env node
// preflight — single consolidated verify entry. Detects the changed paths and runs
// the gate (rubrics/run.mjs) at the right COST TIER. All verification — gate cmd
// checks, tsc, unit, e2e, storybook, ingest integration, codex judges — is now
// expressed as scoped + tiered rubrics, and run.mjs is the one engine: scope decides
// WHICH rubrics fire (by changed path), tier decides HOW DEEP. preflight just picks
// the tier and feeds run.mjs the changed paths.
//
//   --quick (Stop hook): tier=cmd   — fast deterministic checks only (~1-2s)
//   --fast             : tier=test  — + tsc + unit
//   --full             : tier=heavy — everything (e2e / storybook / integration / judges) = merge gate
//   --changed <paths>  : explicit changed path scope; replaces porcelain detection
import { execSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODE_TIERS = {
  quick: 'cmd',
  fast: 'test',
  full: 'heavy',
};

const USAGE = 'usage: pnpm preflight [--quick|--fast|--full] [--changed <paths...>]';

export function parsePreflightArgs(argv) {
  const modes = {
    quick: false,
    fast: false,
    full: false,
  };
  const changed = [];
  const warnings = [];
  let changedSpecified = false;

  for (let i = 0; i < argv.length;) {
    const arg = argv[i];

    if (arg === '--quick') {
      modes.quick = true;
      i += 1;
      continue;
    }

    if (arg === '--fast') {
      modes.fast = true;
      i += 1;
      continue;
    }

    if (arg === '--full') {
      modes.full = true;
      i += 1;
      continue;
    }

    if (arg === '--changed') {
      changedSpecified = true;
      i += 1;
      while (i < argv.length && !argv[i].startsWith('--')) {
        changed.push(argv[i]);
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--')) {
      warnings.push(`unknown flag ${arg}`);
      i += 1;
      continue;
    }

    warnings.push(`unexpected positional argument ${arg}`);
    i += 1;
  }

  const mode = modes.full ? 'full' : modes.fast ? 'fast' : 'quick';
  const error = changedSpecified && changed.length === 0 ? '--changed requires at least one path' : null;

  return {
    mode,
    changedSpecified,
    changed,
    warnings,
    error,
  };
}

export function changedPathsFromPorcelain(status) {
  // changed = uncommitted working-tree / index paths, minus personal untracked.
  return status
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .filter((p) => !p.startsWith('.agents/') && p !== 'skills-lock.json');
}

function getGitStatus() {
  try {
    return execSync('git status --porcelain', { encoding: 'utf8', maxBuffer: 1e7 });
  } catch {
    return '';
  }
}

function runRubrics(args) {
  return spawnSync('node', args, { stdio: 'inherit' });
}

function writeLine(stream, line) {
  stream.write(`${line}\n`);
}

export function runPreflight(argv = process.argv.slice(2), deps = {}) {
  const {
    getStatus = getGitStatus,
    runRubrics: runRubricsCommand = runRubrics,
    stdout = process.stdout,
    stderr = process.stderr,
  } = deps;

  const parsed = parsePreflightArgs(argv);
  for (const warning of parsed.warnings) {
    writeLine(stderr, `[preflight] warning: ${warning}`);
  }

  if (parsed.error) {
    writeLine(stderr, `[preflight] error: ${parsed.error}`);
    writeLine(stderr, `[preflight] ${USAGE}`);
    return 2;
  }

  const tier = MODE_TIERS[parsed.mode];
  const changed = parsed.changedSpecified ? parsed.changed : changedPathsFromPorcelain(getStatus());

  if (!changed.length) {
    writeLine(stdout, '[preflight] no changes — nothing to verify');
    return 0;
  }

  writeLine(stdout, `[preflight:${parsed.mode}] tier=${tier} changed=${changed.length}`);
  const result = runRubricsCommand(['rubrics/run.mjs', '--changed', ...changed, '--tier', tier]);
  return result.status ?? 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runPreflight());
}
