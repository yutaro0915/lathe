import { COST_ANOMALY_BASELINE, COST_FIXTURE_IDS, COST_FIXTURE_PROJECT_ID, Client, CostAnomalyExpectation, DATABASE_URL, DbEvent, DbFileLink, DbSession, FINDING_FIXTURE, FindingOracle, PR_FIXTURE, SUBAGENT_FIXTURE, TurnExpectation, cleanupCostFallbackFixtures, cleanupFindingFixtures, cleanupSubagentFixtures, expandAllTurns, expect, expectTurnJump, findCompactCodexSession, findMultiFileDiffSession, findScopingOracle, registerFixtureHooks, firstSessionId, fmtCompactForTest, fmtCostForTest, getCostAnomalyExpectations, getFindingOracle, getTurnExpectations, gotoViewer, highestCostTurn, hmsToMsForTest, humanizeDurationForTest, join, longestWallDurationTurn, pendingFindingsForSession, readFileSync, readMetaCostForTest, readdirSync, resolve, seedCostFallbackFixtures, seedFindingFixtures, seedPrFixture, seedSubagentFixtures, statSync, test, turnCache, verdictCountForFinding, withDb } from "./helpers";

registerFixtureHooks();

test.describe("Stats tab (in-session)", () => {
  test("the Stats tab shows charts for THIS session only (not cross-session)", async ({
    page,
  }) => {
    await page.goto("/?tab=stats");
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
  test("/overview renders the four cross-session charts", async ({ page }) => {
    await page.goto("/overview");
    await expect(page.locator(`[data-testid="sessbar-title"]`)).toHaveText(/Overview/);
    await expect(page.locator(`[data-testid="stats-embed"]`)).toBeVisible();
    // four charts: cost-over-time + cost-by-model + event composition + biggest
    expect(await page.locator(`[data-testid="chart-card"]`).count()).toBeGreaterThanOrEqual(4);
    expect(await page.locator(`[data-testid="chart-svg"] rect`).count()).toBeGreaterThan(0);
    expect(await page.locator(`[data-testid="hbar-row"]`).count()).toBeGreaterThan(0);
  });

  test("legacy /stats redirects to /overview", async ({ page }) => {
    await page.goto("/stats");
    await expect(page).toHaveURL(/\/overview$/);
    await expect(page.locator(`[data-testid="sessbar-title"]`)).toHaveText(/Overview/);
  });

  test("the project selector scopes the cross-session charts", async ({ page }) => {
    await page.goto("/overview");
    const picker = page.locator(`[data-testid="project-picker"]`);
    const values = await picker
      .locator("option")
      .evaluateAll((opts) =>
        (opts as HTMLOptionElement[]).map((o) => o.value).filter((v) => v !== "all")
      );
    expect(values.length).toBeGreaterThan(0);
    await picker.selectOption(values[0]);
    await expect(page.locator(`[data-testid="sessbar-meta"]`)).not.toContainText("All projects");
    await expect(page.locator(`[data-testid="chart-card"]`).first()).toBeVisible();
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
    await page.locator(`[data-testid="project-picker"]`).selectOption("(no edits)");
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

  test("biggest-sessions rows carry a status chip set and link to the session viewer", async ({
    page,
  }) => {
    await page.goto("/overview");
    const biggest = page.locator(`[data-testid="chart-card"]`, { hasText: "Biggest sessions by cost" });
    await expect(biggest).toBeVisible();
    const firstRow = biggest.locator(`[data-testid="big-row"]`).first();
    await expect(firstRow).toBeVisible();
    // the row is a link (href into the session viewer) and reserves a status slot.
    await expect(firstRow).toHaveAttribute("href", /\?session=/);
    await expect(firstRow.locator(`[data-testid="big-status"]`)).toHaveCount(1);
    // at least one biggest row in the corpus carries an err / pending / cost flag.
    await expect(biggest.locator(`[data-testid="big-status"] [data-testid="badge"]`).first()).toBeVisible();
  });

  test("a model row drills into the Sessions axis filtered to that model", async ({
    page,
  }) => {
    await page.goto("/overview");
    const modelChart = page.locator(`[data-testid="chart-card"]`, { hasText: "Cost by model" });
    // pick a real (linkable) model row and read the model it deep-links to.
    const modelRow = modelChart.locator(`[data-testid="hbar-link"]`).first();
    await expect(modelRow).toBeVisible();
    const model = await modelRow.getAttribute("data-model");
    expect(model).toBeTruthy();
    await modelRow.click();
    await expect(page).toHaveURL(/[?&]model=/);
    // landed on the Sessions axis with the MODEL filter applied (the Model
    // <select> is the one whose options include "All models").
    await expect(page.locator(`[data-testid="globalnav-tab"][data-state="active"]`)).toHaveAttribute("data-nav", "sessions");
    // the list (and its Model filter) lives on the Sessions surface now; the
    // drill-down seeds that filter. The Model <select> is the one whose options
    // include "All models" (in the surface's auto-opened filter panel).
    const modelSelect = page
      .locator(`[data-testid="lds-sessions-filters"] select`)
      .filter({ has: page.locator('option[value="all"]', { hasText: "All models" }) });
    await expect(modelSelect).toHaveValue(model!);
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
