import { COST_ANOMALY_BASELINE, COST_FIXTURE_IDS, COST_FIXTURE_PROJECT_ID, Client, CostAnomalyExpectation, DATABASE_URL, DbEvent, DbFileLink, DbSession, FINDING_FIXTURE, FindingOracle, PR_FIXTURE, SUBAGENT_FIXTURE, TurnExpectation, cleanupCostFallbackFixtures, cleanupFindingFixtures, cleanupSubagentFixtures, expandAllTurns, expect, expectTurnJump, findCompactCodexSession, findScopingOracle, registerFixtureHooks, firstSessionId, fmtCompactForTest, fmtCostForTest, getCostAnomalyExpectations, getFindingOracle, getTurnExpectations, gotoViewer, highestCostTurn, hmsToMsForTest, humanizeDurationForTest, join, longestWallDurationTurn, pendingFindingsForSession, readFileSync, readMetaCostForTest, readdirSync, resolve, seedCostFallbackFixtures, seedFindingFixtures, seedPrFixture, seedSubagentFixtures, statSync, test, turnCache, verdictCountForFinding, withDb } from "./helpers";
import { pickProject, projectOptionValues } from "./topbar";

registerFixtureHooks();

test.describe("Stats tab (in-session)", () => {
  test("the Stats tab shows charts for THIS session only (not cross-session)", async ({
    page,
  }) => {
    // Land on a session that DETERMINISTICALLY has per-turn data (>1 user turn,
    // a non-zero wall-clock turn) so the per-turn "Where this session went" chart
    // has bars to draw. A bare "/?tab=stats" resolves to getPrimarySession(),
    // which — once the cost-anomaly fixtures (seq 2/3/4, no transcript events)
    // are seeded by registerFixtureHooks() — is the earliest root session with
    // ZERO turns, so its per-turn chart is (correctly) its empty state: a
    // test-selection flake, not a chart bug. This still exercises the per-session
    // (not cross-session) Stats tab — the session viewer keeps naming the SESSION.
    const session = await findCompactCodexSession();
    await page.goto(`/?session=${session}&tab=stats`);
    // sessbar still names the SESSION (not 'Overview'/'Statistics'): the tab is
    // per-session by design — cross-session analytics live at /overview.
    await expect(page.locator(`[data-testid="sessbar-title"]`)).not.toHaveText(/^(Overview|Statistics)/);
    await expect(page.locator(`[data-testid="stats-embed"]`)).toBeVisible();
    // the headline chart is per-turn for this run
    await expect(
      page.locator(`[data-testid="chart-card"]`, { hasText: "Where this session went" })
    ).toBeVisible();
    // per-turn SVG + event composition / files / sub-agent bars
    expect(await page.locator(`[data-testid="chart-svg"] rect`).count()).toBeGreaterThan(0);
    expect(await page.locator(`[data-testid="hbar-row"]`).count()).toBeGreaterThan(0);
  });

  test("from the in-session Stats tab, the rail reaches cross-session Overview analytics", async ({
    page,
  }) => {
    // The in-session Stats tab covers ONE session; cross-session analytics live at
    // /overview. The Overview link used to sit in the removed session-list sidebar;
    // the persistent left nav rail now owns that entry point.
    await page.goto("/?tab=stats");
    await expect(page.locator(`[data-testid="stats-embed"]`)).toBeVisible();
    const overviewNav = page.locator('[data-testid="globalnav-tab"][data-nav="overview"]');
    await expect(overviewNav).toBeVisible();
    await overviewNav.click();
    await expect(page).toHaveURL(/\/overview/);
  });
});

test.describe("Overview (/overview) — cross-session analytics", () => {
  test("/overview renders the D31 three-card Trends", async ({ page }) => {
    await page.goto("/overview");
    await expect(page.locator(`[data-testid="sessbar-title"]`)).toHaveText(/Overview/);
    await expect(page.locator(`[data-testid="overview-trends"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="trend-card"]`)).toHaveCount(3);
    await expect(page.locator(`[data-testid="trend-card"][data-trend="cost-by-runner"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="trend-card"][data-trend="cost-over-time"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="trend-card"][data-trend="findings-by-kind"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="runner-cost-row"]`).first()).toBeVisible();
    await expect(page.locator(`[data-testid="time-bar-link"]`).first()).toBeVisible();
    await expect(page.locator(`[data-testid="finding-kind-row"][data-kind="failure_loop"]`)).toBeVisible();
  });

  test("legacy /stats redirects to /overview", async ({ page }) => {
    await page.goto("/stats");
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.locator(`[data-testid="sessbar-title"]`)).toHaveText(/Overview/);
  });

  test("the project selector scopes the cross-session Trends", async ({ page }) => {
    await page.goto("/overview");
    // The TopBar project scope is a custom dropdown now (not a native <select>):
    // read its option values, then drive it by clicking the trigger + the option.
    const values = await projectOptionValues(page);
    expect(values.length).toBeGreaterThan(0);
    await expect(page.locator(`[data-testid="project-menu"]`)).toHaveCount(0);
    await pickProject(page, values[0]);
    await expect(page.locator(`[data-testid="project-picker"]`)).toHaveAttribute("data-value", values[0]);
    await expect(page.locator(`[data-testid="sessbar-meta"]`)).not.toContainText("All projects");
    await expect(page.locator(`[data-testid="trend-card"]`).first()).toBeVisible();
  });

  test("Overview v2 has NO session rail (it is a full-width canvas, not a 2nd Sessions list)", async ({
    page,
  }) => {
    await page.goto("/overview");
    // the old rail (sidebar + "Sessions in scope" session-list + back-link) is gone.
    await expect(page.locator(`[data-testid="overview-page"] [data-testid="session-rail"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="overview-page"] [data-testid="session-list"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="overview-back"]`)).toHaveCount(0);
    // it IS the full-width analysis canvas with the attention panel.
    await expect(page.locator(`[data-testid="overview-canvas"]`)).toBeVisible();
    await expect(page.locator('[data-panel="attention"]')).toBeVisible();
  });

  test("the attention panel is shown and a row click navigates to the session viewer", async ({
    page,
  }) => {
    await page.goto("/overview");
    await pickProject(page, "(no edits)");
    // the cost-alert fixture row is a link straight to that session's viewer.
    const row = page.locator(`[data-attn-group="cost"] [data-testid="attn-row"][data-session-id="${COST_FIXTURE_IDS[1]}"]`
    );
    await expect(row).toBeVisible();
    await row.click();
    await expect(page).toHaveURL(
      new RegExp(`\\?session=${COST_FIXTURE_IDS[1]}`)
    );
    // the global bar now reads "Sessions" (axis moved via a real link, back works).
    await expect(page.locator(`[data-testid="globalnav-tab"][data-state="active"]`)).toHaveAttribute("data-nav", "sessions");
  });

  test("cost outlier and error attention signals use clean red token styling", async ({
    page,
  }) => {
    await page.goto("/overview");
    await pickProject(page, "(no edits)");
    const costRatio = page.locator(`[data-attn-group="cost"] [data-testid="attn-ratio"]`).first();
    const errorBadge = page.locator(`[data-attn-group="errors"] [data-testid="badge"]`).first();
    await expect(costRatio).toBeVisible();
    await expect(errorBadge).toBeVisible();
    await expect(costRatio).toHaveCSS("border-top-color", "rgb(214, 69, 69)");
    await expect(errorBadge).toHaveCSS("border-top-color", "rgb(214, 69, 69)");
  });

  test("a cost-over-time bar drills into the Sessions axis scoped to that period", async ({
    page,
  }) => {
    await page.goto("/overview");
    const bar = page.locator(`[data-testid="time-bar-link"]`).first();
    await expect(bar).toBeVisible();
    const from = await bar.getAttribute("data-from");
    const to = await bar.getAttribute("data-to");
    expect(from).toBeTruthy();
    await bar.click();
    // The drill-down carries the period in the URL and lands on the Sessions axis.
    // The list (and its scoping) lives on the full-width Sessions surface "/" now
    // that the per-session viewer's sidebar was removed; the active period shows as
    // a clearable banner in that surface's (auto-opened) filter panel.
    await expect(page).toHaveURL(new RegExp(`from=${from}`));
    await expect(page.locator(`[data-testid="globalnav-tab"][data-state="active"]`)).toHaveAttribute("data-nav", "sessions");
    const banner = page.locator(`[data-testid="date-range-banner"]`);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-from", from!);
    await expect(banner).toHaveAttribute("data-to", to!);
  });
});
