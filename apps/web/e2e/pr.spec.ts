import { COST_ANOMALY_BASELINE, COST_FIXTURE_IDS, COST_FIXTURE_PROJECT_ID, Client, CostAnomalyExpectation, DATABASE_URL, DbEvent, DbFileLink, DbSession, FINDING_FIXTURE, FindingOracle, PR_FIXTURE, SUBAGENT_FIXTURE, TurnExpectation, cleanupCostFallbackFixtures, cleanupFindingFixtures, cleanupSubagentFixtures, expandAllTurns, expect, expectTurnJump, findCompactCodexSession, findMultiFileDiffSession, findScopingOracle, registerFixtureHooks, firstSessionId, fmtCompactForTest, fmtCostForTest, getCostAnomalyExpectations, getFindingOracle, getTurnExpectations, gotoViewer, highestCostTurn, hmsToMsForTest, humanizeDurationForTest, join, longestWallDurationTurn, pendingFindingsForSession, readFileSync, readMetaCostForTest, readdirSync, resolve, seedCostFallbackFixtures, seedFindingFixtures, seedPrFixture, seedSubagentFixtures, statSync, test, turnCache, verdictCountForFinding, withDb } from "./helpers";

registerFixtureHooks();

test.describe("PR linkage", () => {
  test("PR list opens linked sessions, and session view shows the PR chip", async ({ page }) => {
    await seedPrFixture();
    await page.goto(`/pr?pr=${encodeURIComponent(PR_FIXTURE.prId)}`);

    await expect(page.locator(`[data-testid="pr-list-item"][class~="active"]`)).toContainText("G1 fixture PR");
    await expect(page.locator(`[data-testid="pr-hero"]`)).toContainText("#1");
    await expect(page.locator(`[data-testid="linked-session"]`, { hasText: "Fixture session linked by SHA" })).toBeVisible();
    await expect(page.locator(`[data-testid="linked-session"]`, { hasText: "Fixture session linked by branch fallback" })).toBeVisible();

    await page.locator(`[data-testid="linked-session"]`, { hasText: "Fixture session linked by SHA" }).click();
    await expect(page).toHaveURL(new RegExp(`session=${PR_FIXTURE.shaSession}`));
    await expect(page.locator(`[data-testid="sessbar-title"]`)).toContainText("Fixture session linked by SHA");
    await expect(page.locator(`[data-testid="sessbar"] [class~="pr-chip"]`, { hasText: "#1 open" })).toBeVisible();
  });
});
