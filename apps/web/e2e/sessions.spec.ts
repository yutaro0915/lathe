import { COST_ANOMALY_BASELINE, COST_FIXTURE_IDS, COST_FIXTURE_PROJECT_ID, Client, CostAnomalyExpectation, DATABASE_URL, DbEvent, DbFileLink, DbSession, FINDING_FIXTURE, FindingOracle, PR_FIXTURE, SUBAGENT_FIXTURE, TurnExpectation, cleanupCostFallbackFixtures, cleanupFindingFixtures, cleanupSubagentFixtures, expandAllTurns, expect, expectTurnJump, findCompactCodexSession, findMultiFileDiffSession, findScopingOracle, registerFixtureHooks, firstSessionId, fmtCompactForTest, fmtCostForTest, getCostAnomalyExpectations, getFindingOracle, getTurnExpectations, gotoViewer, highestCostTurn, hmsToMsForTest, humanizeDurationForTest, join, longestWallDurationTurn, pendingFindingsForSession, readFileSync, readMetaCostForTest, readdirSync, resolve, seedCostFallbackFixtures, seedFindingFixtures, seedPrFixture, seedSubagentFixtures, statSync, test, turnCache, verdictCountForFinding, withDb } from "./helpers";

registerFixtureHooks();

// Assertions are structural (counts change, classes toggle, URL changes) rather
// than tied to specific seeded titles, so they stay green as the ingested
// transcripts grow.

test.describe("Sessions surface + viewer (/)", () => {
  test("the list surface shows sessions; opening a row reveals the named viewer", async ({ page }) => {
    // bare "/" is the full-width Sessions LIST surface (left = nav only).
    await page.goto("/");
    await expect(page.locator(`[data-testid="session-list"] [class~="session-item"]`).first()).toBeVisible();
    // opening a row drills into the per-session WORKSPACE: named header + timeline.
    await gotoViewer(page);
    await expect(page.locator(`[data-testid="sessbar"] [class~="sessbar-title"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="sessbar"] [class~="sessbar-stats"]`)).toContainText("tokens");
    expect(await page.locator(`[data-testid="event-row"]`).count()).toBeGreaterThan(0);
  });

  test("tabs switch the centre content", async ({ page }) => {
    await gotoViewer(page);
    const tabs = page.locator(`[data-testid="tabs"] [class~="tab"]`);
    await tabs.filter({ hasText: "Raw JSON" }).click();
    await expect(page.locator(`[data-testid="tabs"] [class~="tab"][class~="active"]`)).toHaveText(/Raw JSON/);
    await tabs.filter({ hasText: "Subagents" }).click();
    await expect(page.locator(`[data-testid="tabs"] [class~="tab"][class~="active"]`)).toHaveText(/Subagents/);
    await tabs.filter({ hasText: "Transcript" }).click();
    await expect(page.locator(`[data-testid="tabs"] [class~="tab"][class~="active"]`)).toHaveText(/Transcript/);
    await expect(page.locator(`[data-testid="event-row"]`).first()).toBeVisible();
  });

  test("event-type filter reduces the timeline", async ({ page }) => {
    await gotoViewer(page);
    const before = await page.locator(`[data-testid="event-row"]`).count();
    // the event-type filter moved from the (removed) left sidebar into the
    // transcript toolbar; in the default "hide" mode, turning a type off drops
    // its rows from the timeline.
    await page.locator(`[data-testid="transcript-filters"] [class~="event-type-badge"]`).first().click();
    await expect
      .poll(async () => page.locator(`[data-testid="event-row"]`).count())
      .toBeLessThan(before);
  });

  test("clicking an event selects it (detail panel)", async ({ page }) => {
    await gotoViewer(page);
    const rows = page.locator(`[data-testid="event-row"]`);
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    expect(n).toBeGreaterThan(0);
    await rows.first().click();
    await expect(page.locator(`[data-testid="event-row"][class~="selected"]`)).toHaveCount(1);
  });

  test("the surface search filters the list and clears", async ({ page }) => {
    // the search box lives on the list surface itself (no session open yet).
    await page.goto("/");
    await expect(page.locator(`[data-testid="session-list"] [class~="session-item"]`).first()).toBeVisible();
    const before = await page.locator(`[data-testid="session-item"]`).count();
    expect(before).toBeGreaterThan(0);
    const box = page.getByPlaceholder(/Search sessions/i);
    await box.fill("zzz-no-such-session-zzz");
    // a no-match search collapses the full-width list (there is no session being
    // viewed to force-include on this surface).
    await expect(page.locator(`[data-testid="session-item"]`)).toHaveCount(0);
    await box.fill("");
    await expect(page.locator(`[data-testid="session-item"]`)).toHaveCount(before);
  });

  test("clicking a list row navigates with ?session= into the viewer", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(`[data-testid="session-list"] [class~="session-item"]`).first()).toBeVisible();
    await page.locator(`[data-testid="session-item"]`).first().click();
    await expect(page).toHaveURL(/\?session=/);
    // the viewer no longer carries its own session-list sidebar (navigation lives
    // in the left rail); a row click lands in the named per-session workspace.
    await expect(page.locator(`[data-testid="sessbar"] [class~="sessbar-title"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="event-row"]`).first()).toBeVisible();
  });

  test("Pin persists to localStorage", async ({ page }) => {
    await gotoViewer(page);
    await page.locator(`[data-testid="event-row"]`).nth(0).click();
    await page.locator(`[data-testid="btn"]`, { hasText: /Pin/i }).first().click();
    const pins = await page.evaluate(() => localStorage.getItem("lathe.pins"));
    expect(pins && pins.length).toBeTruthy();
  });

  test("cost is derived from token usage and shown ($)", async ({ page }) => {
    // the list surface shows priceable (Opus) sessions with a real dollar amount.
    await page.goto("/");
    await expect(page.locator(`[data-testid="session-list"] [class~="session-item"]`).first()).toBeVisible();
    const dollarCosts = page.locator(`[data-testid="session-item"] [class~="chip"][class~="cost"]`, { hasText: "$" });
    expect(await dollarCosts.count()).toBeGreaterThan(0);
    // and the viewer header carries the matching Cost stat.
    await gotoViewer(page);
    await expect(
      page.locator(`[data-testid="sessbar-stats"] [class~="kstat"]`, { hasText: "cost" })
    ).toBeVisible();
  });
});

test.describe("Cost anomaly detection", () => {
  const CLAUDE_JUMP_SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";

  test("session-list anomaly chips match an independent DB baseline oracle", async ({ page }) => {
    const oracle = await getCostAnomalyExpectations();
    const expected = oracle
      .filter((r) => r.cost_anomaly && !r.parent_session_id)
      .map((r) => r.session_id)
      .sort();

    await page.goto("/");
    const actual = (
      await page.locator(`[data-testid="session-list"] [class~="session-item"]`).evaluateAll((items) =>
        items
          .filter((item) => item.querySelector(".anomaly-chip"))
          .map((item) => item.getAttribute("data-session-id"))
          .filter((id): id is string => !!id)
      )
    ).sort();

    expect(actual).toEqual(expected);
  });

  test("n<10 groups and cost-NULL sessions use the absolute-floor fallback", async ({ page }) => {
    const oracle = await getCostAnomalyExpectations(COST_FIXTURE_IDS);
    const byId = new Map(oracle.map((r) => [r.session_id, r]));
    const low = byId.get(COST_FIXTURE_IDS[0])!;
    const high = byId.get(COST_FIXTURE_IDS[1])!;
    const nil = byId.get(COST_FIXTURE_IDS[2])!;

    for (const row of [low, high, nil]) {
      expect(row.cost_anomaly_group_size).toBeLessThan(COST_ANOMALY_BASELINE.minimumGroupSize);
      expect(row.cost_anomaly_threshold_usd).toBe(COST_ANOMALY_BASELINE.absoluteFloorUsd);
    }
    expect(low.cost_anomaly).toBe(false);
    expect(high.cost_anomaly).toBe(true);
    expect(nil.cost_usd).toBeNull();
    expect(nil.cost_anomaly).toBe(false);

    await page.goto("/");
    await page.getByPlaceholder(/Search sessions/i).fill("E2E fallback cost");
    // the three cost fixtures match the search on the full-width Sessions list
    // surface; assert on the three fixture rows specifically.
    for (const id of COST_FIXTURE_IDS) {
      await expect(page.locator(`[data-testid="session-item"][data-session-id="${id}"]`)).toHaveCount(1);
    }
    await expect(
      page.locator(`[data-testid="session-item"][data-session-id="${COST_FIXTURE_IDS[1]}"] [class~="anomaly-chip"]`)
    ).toHaveText("▲ cost");
    await expect(
      page.locator(`[data-testid="session-item"][data-session-id="${COST_FIXTURE_IDS[0]}"] [class~="anomaly-chip"]`)
    ).toHaveCount(0);
    await expect(
      page.locator(`[data-testid="session-item"][data-session-id="${COST_FIXTURE_IDS[2]}"] [class~="anomaly-chip"]`)
    ).toHaveCount(0);
  });

  test("overview surfaces the G9 cost flag in the cost-outliers list", async ({ page }) => {
    await page.goto("/overview");
    await page.locator(`[data-testid="project-picker"]`).selectOption("(no edits)");
    // Overview v2 has no session rail; the anomalous session is a row in the
    // attention panel's cost-alerts column, carrying a ▲ cost flag, and links
    // straight to that session's viewer.
    const row = page.locator(`[data-attn-group="cost"] [class~="attn-row"][data-session-id="${COST_FIXTURE_IDS[1]}"]`
    );
    await expect(row).toBeVisible();
    // the row shows the session cost and an overrun ratio (cost ÷ baseline). Being
    // in the cost-alerts column already means it is anomalous, so the ▲ flag is
    // redundant here; the ratio badge is the "how bad" signal.
    await expect(row.locator(`[data-testid="attn-ratio"]`)).toBeVisible();
    await expect(row).toContainText("$51.00");
    await expect(row).toHaveAttribute(
      "href",
      `/?session=${encodeURIComponent(COST_FIXTURE_IDS[1])}`
    );
  });

  test("highest-turn jump expands and activates the estimated-cost turn for Claude Code", async ({ page }) => {
    const target = highestCostTurn(await getTurnExpectations(CLAUDE_JUMP_SID));
    expect(target).toBeTruthy();
    await expectTurnJump(page, CLAUDE_JUMP_SID, "COSTLIEST TURN", target, "cost");
  });

  test("highest-turn jump expands and activates the duration fallback turn for Codex", async ({ page }) => {
    const codexSession = await findCompactCodexSession();
    const target = longestWallDurationTurn(await getTurnExpectations(codexSession));
    expect(target).toBeTruthy();
    expect(target.wallDurationMs).toBeGreaterThan(0);
    await expectTurnJump(page, codexSession, "LONGEST TURN", target, "duration");
  });

  test("error-turn jump expands and activates the first failing turn", async ({ page }) => {
    const target = (await getTurnExpectations(CLAUDE_JUMP_SID)).find(
      (t) => t.steps > 0 && t.errors > 0
    );
    expect(target).toBeTruthy();
    await expectTurnJump(page, CLAUDE_JUMP_SID, "FIRST ERROR TURN", target!);
  });
});

test.describe("Sub-agent runs (Subagents tab)", () => {
  // session known to spawn 3 distinct general-purpose runs
  const SID = "da2ac032-a905-4267-8e5f-851456926a79";

  test("linked Codex sub-agent shows child session facts and opens the sub-session", async ({
    page,
  }) => {
    await page.goto(`/?session=${SUBAGENT_FIXTURE.parentId}&tab=subagents`);
    const linked = page.locator(`[data-testid="sa-card"]`, { hasText: "Linked fixture subagent task" });
    await expect(linked).toContainText("3 steps");
    await expect(linked).toContainText("2 tools");
    await expect(linked).toContainText(/gpt-5/i);
    await expect(linked).toContainText("$0.13");
    await expect(linked).toContainText("OPEN SUB-SESSION");
    await linked.getByText("OPEN SUB-SESSION").click();
    await expect(page).toHaveURL(new RegExp(`session=${SUBAGENT_FIXTURE.childId}`));
    await expect(page.locator(`[data-testid="sessbar-title"]`)).toHaveText("Fixture linked sub-session");
  });

  test("unlinked Codex sub-agent is explicit about missing internal steps", async ({
    page,
  }) => {
    await page.goto(`/?session=${SUBAGENT_FIXTURE.parentId}&tab=subagents`);
    const unlinked = page.locator(`[data-testid="sa-card"]`, { hasText: "Missing fixture subagent task" });
    await expect(unlinked).toContainText("internal steps not captured");
  });

  test("sub-sessions are hidden from the list until the toggle is enabled", async ({
    page,
  }) => {
    // The session list (and its "show sub-sessions" toggle) lives on the Sessions
    // surface ("/") now that the per-session viewer's sidebar was removed.
    await page.goto("/");
    await expect(page.locator(`[data-testid="session-list"] [class~="session-item"]`).first()).toBeVisible();
    const childItem = page.locator(`[data-testid="session-list"] [data-session-id="${SUBAGENT_FIXTURE.childId}"]`
    );
    await expect(childItem).toHaveCount(0);
    // open the collapsible filters, then enable the sub-sessions toggle.
    await page.getByRole("button", { name: "Filters" }).click();
    await page.getByLabel("show sub-sessions").check();
    await expect(childItem).toBeVisible();
  });

  test("overview lists one card per distinct run, not one flat list per name", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    // a tab bar with Overview + one tab per run
    await expect(page.locator(`[data-testid="sa-tab"]`).first()).toContainText(/Overview/);
    const runTabs = page.locator(`[data-testid="sa-tab"]`).filter({ hasText: "general-purpose" });
    expect(await runTabs.count()).toBeGreaterThan(1); // distinct runs, not merged
    // overview shows a card per run with a step count
    const cards = page.locator(`[data-testid="sa-card"]`);
    expect(await cards.count()).toBe(await runTabs.count());
    await expect(cards.first().locator(`[data-testid="sa-card-meta"]`)).toContainText(/steps/);
  });

  test("clicking a run opens its detail tab with the internal execution", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(`[data-testid="sa-card"]`).first().click();
    // the tabbar reflects the opened run + per-run execution rows appear
    await expect(page.locator(`[data-testid="sa-tabbar"] [class~="sa-tab"][class~="active"] [class~="sa-tab-idx"]`)).toHaveText("1");
    await expect
      .poll(async () => page.locator(`[data-testid="sa-detail"] [class~="event-row"][class~="child-row"]`).count())
      .toBeGreaterThan(0);
    // selecting an internal step drives the right detail panel
    await page.locator(`[data-testid="sa-detail"] [class~="event-row"][class~="child-row"]`).first().click();
    await expect(page.locator(`[data-testid="sa-detail"] [class~="event-row"][class~="child-row"][class~="selected"]`)).toHaveCount(1);
    await expect(page.locator(`[data-testid="detail"] [class~="detail-head"] [class~="dtitle"]`)).toBeVisible();
  });

  test("tabbar steps between runs", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(`[data-testid="sa-card"]`).first().click();
    await expect(page.locator(`[data-testid="sa-tabbar"] [class~="sa-tab"][class~="active"] [class~="sa-tab-idx"]`)).toHaveText("1");
    await page.locator(`[data-testid="sa-tabbar"] [class~="sa-tab"]`, { has: page.locator(`[data-testid="sa-tab-idx"]`, { hasText: "2" }) }).click();
    await expect(page.locator(`[data-testid="sa-tabbar"] [class~="sa-tab"][class~="active"] [class~="sa-tab-idx"]`)).toHaveText("2");
    await expect.poll(async () => page.locator(`[data-testid="sa-detail"] [class~="event-row"][class~="child-row"]`).count()).toBeGreaterThan(0);
  });

  test("a launcher row in the transcript jumps to its run detail", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    await expandAllTurns(page);
    const jump = page.locator(`[data-testid="sa-jump"]`).first();
    if ((await jump.count()) > 0) {
      await jump.click();
      await expect(page.locator(`[data-testid="tabs"] [class~="tab"][class~="active"]`)).toHaveText(/Subagents/);
      await expect(page.locator(`[data-testid="sa-tabbar"] [class~="sa-tab"][class~="active"] [class~="sa-tab-idx"]`)).toBeVisible();
    }
  });

  test("each run shows which model ran and its cost", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    // overview cards carry a model chip + a $ cost
    await expect(page.locator(`[data-testid="sa-card"] [class~="sa-model"]`).first()).toBeVisible();
    await expect(page.locator(`[data-testid="sa-card"] [class~="sa-cost"]`).first()).toContainText("$");
    // the detail view exposes Model + Cost stats
    await page.locator(`[data-testid="sa-tab"]`, { hasText: "general-purpose" }).first().click();
    await expect(
      page.locator(`[data-testid="sa-detail-stats"] [class~="stat"]`, { hasText: "Model" })
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="sa-detail-stats"] [class~="stat"]`, { hasText: "Cost" })
    ).toBeVisible();
  });

  test("opening a run does NOT duplicate the run into the right aside; it asks for a step", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(`[data-testid="sa-card"]`).first().click();
    // run is open in the centre (stats strip is the canonical place)
    await expect(page.locator(`[data-testid="sa-detail-stats"]`)).toBeVisible();
    // the right aside is reserved for the selected EXECUTION step — until one is
    // picked it shows a quiet placeholder, not a second copy of the run detail
    await expect(
      page.locator('[data-testid="aside"] [data-aside-placeholder="step-inspect"]')
    ).toBeVisible();
    await expect(page.locator(`[data-testid="aside"] [class~="detail-head"]`)).toHaveCount(0);
    // picking a step swaps the aside to that step's detail (placeholder gone)
    await expect
      .poll(async () => page.locator(`[data-testid="sa-detail"] [class~="event-row"][class~="child-row"]`).count())
      .toBeGreaterThan(0);
    await page.locator(`[data-testid="sa-detail"] [class~="event-row"][class~="child-row"]`).first().click();
    await expect(
      page.locator('[data-testid="aside"] [data-aside-placeholder="step-inspect"]')
    ).toHaveCount(0);
    await expect(page.locator(`[data-testid="aside"] [class~="detail-head"] [class~="dtitle"]`)).toBeVisible();
  });

  test("Result = the run's own verdict; child-step failures are a separate count", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(`[data-testid="sa-card"]`).first().click();
    const result = page.locator(`[data-testid="sa-detail-stats"] [class~="stat"]`, { hasText: "Result" }).locator(`[data-testid="stat-v"]`);
    await expect(result).toHaveText(/^(ok|error)$/);
    // if any child step failed, that fact is surfaced under Steps (NOT folded
    // into Result) — so "ok" + "N failed" can coexist without contradiction.
    const note = page.locator(`[data-testid="sa-detail-stats"] [class~="failed-steps-note"]`);
    if ((await note.count()) > 0) {
      await expect(note.first()).toContainText(/failed/);
    }
  });
});

test.describe("Global nav & IA axes", () => {
  for (const route of ["/", "/findings", "/pr", "/overview"]) {
    test(`the persistent global bar is present on ${route}`, async ({ page }) => {
      await page.goto(route);
      const nav = page.locator(`[data-testid="globalnav"]`);
      await expect(nav).toBeVisible();
      // the four axes are always there; chat is never a bar item.
      await expect(nav.locator('[data-testid="globalnav-tab"][data-nav="sessions"]')).toBeVisible();
      await expect(nav.locator('[data-testid="globalnav-tab"][data-nav="findings"]')).toBeVisible();
      await expect(nav.locator('[data-testid="globalnav-tab"][data-nav="pr"]')).toBeVisible();
      await expect(nav.locator('[data-testid="globalnav-tab"][data-nav="overview"]')).toBeVisible();
      await expect(nav.locator('[data-testid="globalnav-tab"]', { hasText: "Chat" })).toHaveCount(0);
    });
  }

  test("the current axis is highlighted on each route", async ({ page }) => {
    const cases: [string, string][] = [
      ["/", "sessions"],
      ["/findings", "findings"],
      ["/pr", "pr"],
      ["/overview", "overview"],
    ];
    for (const [route, nav] of cases) {
      await page.goto(route);
      const active = page.locator(`[data-testid="globalnav-tab"][class~="active"]`);
      await expect(active).toHaveCount(1);
      await expect(active).toHaveAttribute("data-nav", nav);
    }
  });

  test("no Chat entry point survives in the session viewer (chat removed)", async ({ page }) => {
    await gotoViewer(page);
    // neither the old tab nor the sessbar Discuss chip exist anymore.
    await expect(page.locator(`[data-testid="tabs"] [class~="tab"]`, { hasText: "Chat" })).toHaveCount(0);
    await expect(page.locator(`[data-testid="chat-session-chip"]`)).toHaveCount(0);
  });

  test("the Findings axis renders the cross-session master-detail and decides a verdict", async ({
    page,
  }) => {
    const oracle = await getFindingOracle();
    await page.goto("/findings");
    await expect(page.locator(`[data-testid="globalnav-tab"][class~="active"]`)).toHaveAttribute("data-nav", "findings");

    // the same master-detail component as the tab, in axis mode
    await expect(page.locator('[data-testid="findings-tab"][data-findings-mode="axis"]')).toBeVisible();
    const row = page.locator(`[data-testid="finding-row"][data-finding-id="${oracle.id}"]`);
    await expect(row).toBeVisible();
    await row.click();
    const detail = page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`);
    await expect(detail).toBeVisible();
    await detail.locator(`[data-testid="finding-verdict-reason"]`).fill("axis verified");
    await detail.locator(`[data-testid="finding-verdict-btn"][class~="accept"]`).click();
    await expect(page.locator(`[data-testid="finding-verdict-toast"][class~="accept"]`)).toContainText("Accepted");
    await expect.poll(async () => verdictCountForFinding(FINDING_FIXTURE.titles.jump)).toBe(1);

    // restore the fixture to pending so the shared seed is not contaminated for
    // later tests (findings are seeded once in beforeAll).
    await page.locator(`[data-testid="finding-verdict-toast"] [class~="btn"]`, { hasText: "Undo" }).click();
    await expect.poll(async () => verdictCountForFinding(FINDING_FIXTURE.titles.jump)).toBe(0);
  });

  test("the session Findings tab shows only findings attached to THIS session", async ({
    page,
  }) => {
    const oracle = await findScopingOracle();

    // owner session: the finding IS attached → its row is present
    await page.goto(`/?session=${encodeURIComponent(oracle.ownerSession)}&tab=findings`);
    await expect(page.locator('[data-testid="findings-tab"][data-findings-mode="session"]')).toBeVisible();
    await expect(
      page.locator(`[data-testid="finding-row"][data-finding-id="${oracle.findingId}"]`),
    ).toBeVisible();
    // the session tab no longer carries the All/This cross-session toggle
    await expect(page.locator(`[data-testid="findings-tab"]`, { hasText: "All sessions" })).toHaveCount(0);
    // the in-tab "all findings" link is removed (requirement F) — the
    // cross-session axis is reached from the global bar, not from this tab.
    await expect(page.locator(`[data-testid="findings-axis-link"]`)).toHaveCount(0);

    // other session: the SAME finding is NOT attached → its row is absent
    await page.goto(`/?session=${encodeURIComponent(oracle.otherSession)}&tab=findings`);
    await expect(page.locator('[data-testid="findings-tab"][data-findings-mode="session"]')).toBeVisible();
    await expect(
      page.locator(`[data-testid="finding-row"][data-finding-id="${oracle.findingId}"]`),
    ).toHaveCount(0);
    // …but on the axis it is reachable regardless of which session you came from
    await page.goto("/findings");
    await page.locator('[data-testid="findings-filter"] button', { hasText: "All" }).click();
    await expect(page.locator(`[data-testid="finding-row"][data-finding-id="${oracle.findingId}"]`)).toBeVisible();
  });

  test("deep-linking a session opens that session's workspace under the Sessions axis", async ({
    page,
  }) => {
    const oracle = await findScopingOracle();

    // The per-session viewer no longer carries a session-list sidebar (cross-
    // session navigation lives in the left nav rail). Deep-linking a session (as
    // the Findings-axis jump does) must open THAT session's workspace, with the
    // global rail showing the Sessions axis active.
    await page.goto(`/?session=${encodeURIComponent(oracle.ownerSession)}&tab=transcript`);
    await expect(page).toHaveURL(new RegExp(`session=${oracle.ownerSession}`));
    await expect(page.locator(`[data-testid="sessbar"] [class~="sessbar-title"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="globalnav-tab"][class~="active"]`)).toHaveAttribute("data-nav", "sessions");
    const ownerTitle = await page.locator(`[data-testid="sessbar-title"]`).textContent();

    // switching to another session swaps the workspace to that session — no stale
    // header is left behind.
    await page.goto(`/?session=${encodeURIComponent(oracle.otherSession)}&tab=transcript`);
    await expect(page).toHaveURL(new RegExp(`session=${oracle.otherSession}`));
    await expect(page.locator(`[data-testid="sessbar"] [class~="sessbar-title"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="sessbar-title"]`)).not.toHaveText(ownerTitle ?? "");
    await expect(page.locator(`[data-testid="globalnav-tab"][class~="active"]`)).toHaveAttribute("data-nav", "sessions");
  });

  test("the deep-linked session is always identifiable in its workspace header", async ({
    page,
  }) => {
    const oracle = await findScopingOracle();
    await page.goto(`/?session=${encodeURIComponent(oracle.ownerSession)}&tab=transcript`);

    // "which one am I viewing" must never be lost: with the session-list sidebar
    // gone, the sessbar header is the single source of truth and always names the
    // open session (requirement C, restated for the rail-nav IA).
    await expect(page.locator(`[data-testid="sessbar"] [class~="sessbar-title"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="event-row"]`).first()).toBeVisible();
  });
});

test.describe("Harness signals", () => {
  test("nested memory loads & hook firings appear in the transcript + filters", async ({
    page,
  }) => {
    await page.goto("/?session=da2ac032-a905-4267-8e5f-851456926a79");
    await expandAllTurns(page);
    // event-type filter (now in the transcript toolbar) exposes Memory + Hook
    await expect(
      page.locator(`[data-testid="transcript-filters"] [class~="event-type-badge"]`, { hasText: "Memory" })
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="transcript-filters"] [class~="event-type-badge"]`, { hasText: "Hook" })
    ).toBeVisible();
    // and at least one memory event renders in the timeline with its own icon
    await expect(page.locator(`[data-testid="timeline"] [class~="event-icon"][class~="memory"]`).first()).toBeVisible();
  });

  test("the overview charts break down where the actions went across sessions", async ({
    page,
  }) => {
    await page.goto("/overview");
    // memory loads / hook firings are first-class event types — they roll up into
    // the cross-session event-composition chart (and stay filterable in transcripts).
    await expect(
      page.locator(`[data-testid="chart-card"]`, { hasText: "Where the actions went" })
    ).toBeVisible();
    await expect(page.locator(`[data-testid="chart-card"] [class~="hbar-row"]`).first()).toBeVisible();
  });
});

test.describe("Codex support", () => {
  test("Codex sessions are ingested and shown alongside Claude (runner badge)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.locator(`[data-testid="session-list"] [class~="runner-badge"]`, { hasText: "Codex" }).first()
    ).toBeVisible();
  });

  test("the overview model chart includes Codex GPT models", async ({ page }) => {
    await page.goto("/overview");
    // Codex GPT models land in the same per-model cost breakdown as Claude
    const modelChart = page.locator(`[data-testid="chart-card"]`, { hasText: "Cost by model" });
    await expect(modelChart).toBeVisible();
    await expect(modelChart).toContainText(/gpt-5/i);
  });

  test("Codex skill use (reading a SKILL.md) is surfaced as a skill event", async ({
    page,
  }) => {
    // a Codex session that used the openai-docs skill by reading its SKILL.md.
    // Codex has no skill tool, so this is detected from the shell read — it must
    // still show up as a first-class skill (it was previously lost as a file_read).
    await page.goto("/?session=019e9d30-e0a9-7752-b11c-70aa8644e17f&tab=skills");
    await expect(page.locator(`[data-testid="timeline"] [class~="event-icon"][class~="skill"]`).first()).toBeVisible();
    await expect(page.locator(`[data-testid="timeline"]`)).toContainText(/openai-docs/);
  });
});

// ---- copy hygiene (design/ui-design-language.md, copy principles 2026-06-12) -
// Product copy is neutral English micro-labels: no Japanese, no Japanese/English
// mixed strings, no editorial phrasing. This is a STATIC source check — it walks
// the UI source under components/ and app/ and asserts no CJK code points appear.
// Out of scope (not UI copy, never matched by this check): e2e fixtures/specs,
// lib/, and any DB-derived dynamic strings (those live in the database, not in
// source). Comments are normalized too, so the check is "no CJK anywhere in the
// UI source tree" — the strongest form of the grep gate.
test.describe("copy hygiene (no Japanese in UI source)", () => {
  const CJK = /[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]/;
  const UI_DIRS = ["components", "app"] as const;
  // apps/web root, resolved from this spec's directory (apps/web/e2e).
  const WEB_ROOT = resolve(__dirname, "..");

  function collectSources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        out.push(...collectSources(full));
      } else if (/\.(tsx?|css)$/.test(entry)) {
        out.push(full);
      }
    }
    return out;
  }

  for (const sub of UI_DIRS) {
    test(`apps/web/${sub} contains no Japanese characters`, () => {
      const offenders: string[] = [];
      for (const file of collectSources(join(WEB_ROOT, sub))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (CJK.test(line)) {
            offenders.push(`${file.replace(WEB_ROOT + "/", "")}:${i + 1}: ${line.trim()}`);
          }
        });
      }
      expect(offenders, `Japanese found in apps/web/${sub}:\n${offenders.join("\n")}`).toEqual([]);
    });
  }
});
