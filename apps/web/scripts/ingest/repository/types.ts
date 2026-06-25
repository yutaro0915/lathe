import type { HarnessSnapshot } from '../harness';

export interface InsertCounts {
  projects: number;
  sessions: number;
  events: number;
  sessionCommits: number;
  commitShaMisses: number;
  changedFiles: number;
  hunks: number;
  attributions: number;
  eventFiles: number;
  annotations: number;
  harnessVersions: number;
}

export interface InsertBuiltOptions {
  harnessSnapshots?: Map<string, HarnessSnapshot>;
  backfillHarness?: boolean;
  existingHarnessStamps?: Map<string, string>;
}

export interface ResetDatabaseOptions {
  existingHarnessStamps?: Map<string, string>;
}
