// e2e/fixtures/index.ts — barrel for the e2e seed*/cleanup* fixture machinery.
//
// Extracted from e2e/helpers.ts to keep every file under the file-size gate (I4).
// helpers.ts does `export * from "./fixtures"`, so every existing
// `import { … } from "./helpers"` site keeps resolving these symbols unchanged.
import { test } from "@playwright/test";

export * from "./db";
export * from "./findings";
export * from "./subagent";
export * from "./cost";
export * from "./pr";

import { seedCostFallbackFixtures, cleanupCostFallbackFixtures } from "./cost";
import { seedFindingFixtures, cleanupFindingFixtures } from "./findings";
import { seedSubagentFixtures, cleanupSubagentFixtures } from "./subagent";

export function registerFixtureHooks() {
  test.beforeAll(async () => {
    await seedCostFallbackFixtures();
    await seedFindingFixtures();
    await seedSubagentFixtures();
  });

  test.afterAll(async () => {
    await cleanupSubagentFixtures();
    await cleanupFindingFixtures();
    await cleanupCostFallbackFixtures();
  });
}
