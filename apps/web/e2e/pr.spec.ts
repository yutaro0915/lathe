import { expect, PR_FIXTURE, registerFixtureHooks, seedPrFixture, test } from "./helpers";

registerFixtureHooks();

test.describe("PR linkage", () => {
  test("PR list navigates to the fixture detail", async ({ page }) => {
    await seedPrFixture();
    await page.goto("/pr");

    await expect(page.locator(`[data-testid="pr-list"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="pr-detail"]`)).toHaveCount(0);

    const row = page.locator(`[data-testid="pr-list-row"]`, { hasText: "G1 fixture PR: SHA and branch linkage" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("#1");
    await expect(row).toContainText("+12 -3");

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/pr\\?pr=${encodeURIComponent(PR_FIXTURE.prId)}`));
    await expect(page.locator(`[data-testid="pr-detail"]`)).toContainText("G1 fixture PR: SHA and branch linkage");
  });

  test("PR detail shows produced-by attribution, changed-files state, reviews, and session jump", async ({ page }) => {
    await seedPrFixture();
    await page.goto(`/pr?pr=${encodeURIComponent(PR_FIXTURE.prId)}`);

    await expect(page.locator(`[data-testid="pr-detail"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="pr-sidebar"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="pr-main"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="pr-title"]`)).toContainText("G1 fixture PR: SHA and branch linkage");
    await expect(page.locator(`[data-testid="pr-state-badge"]`)).toContainText("open");
    await expect(page.locator(`[data-testid="pr-detail-meta"]`)).toContainText(`${PR_FIXTURE.branch} -> main`);
    await expect(page.locator(`[data-testid="pr-github-link"]`)).toHaveAttribute("href", "https://github.com/lathe-fixture/g1-pr-linkage/pull/1");

    const produced = page.locator(`[data-testid="pr-produced-by"]`);
    await expect(produced.locator(`[data-testid="pr-session-row"]`)).toHaveCount(2);

    const shaRow = produced.locator(`[data-testid="pr-session-row"]`, { hasText: "Fixture session linked by SHA" });
    await expect(shaRow).toContainText(PR_FIXTURE.shaPrefix);
    await expect(shaRow.locator(`[data-testid="pr-link-strength"]`)).toContainText(PR_FIXTURE.shaPrefix);

    const branchRow = produced.locator(`[data-testid="pr-session-row"]`, { hasText: "Fixture session linked by branch fallback" });
    await expect(branchRow.locator(`[data-testid="pr-link-strength"]`)).toContainText("branch fallback");

    const changedFiles = page.locator(`[data-testid="pr-changed-files"]`);
    await expect(changedFiles).toContainText("Changed files");
    await expect(changedFiles).toContainText("2");
    await expect(changedFiles).toContainText("+12 -3");
    await expect(changedFiles.locator(`[data-testid="pr-file-row"]`)).toHaveCount(0);
    await expect(changedFiles.locator(`[data-testid="empty"]`)).toContainText("No imported file-level diff is available");

    const reviews = page.locator(`[data-testid="pr-reviews"]`);
    await expect(reviews).toContainText("approved");
    await expect(reviews).toContainText("fixture review");

    await shaRow.click();
    await expect(page).toHaveURL(new RegExp(`session=${PR_FIXTURE.shaSession}`));
    await expect(page.locator(`[data-testid="sessbar-title"]`)).toContainText("Fixture session linked by SHA");
    await expect(page.locator(`[data-testid="sessbar"] [data-testid="pr-chip"]`, { hasText: "#1 open" })).toBeVisible();
  });
});
