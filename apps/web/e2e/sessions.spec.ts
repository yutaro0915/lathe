import { COST_ANOMALY_BASELINE, COST_FIXTURE_IDS, COST_FIXTURE_PROJECT_ID, Client, CostAnomalyExpectation, DATABASE_URL, DbEvent, DbFileLink, DbSession, FINDING_FIXTURE, FindingOracle, PR_FIXTURE, SUBAGENT_FIXTURE, TurnExpectation, cleanupCostFallbackFixtures, cleanupFindingFixtures, cleanupSubagentFixtures, expandAllTurns, expect, expectTurnJump, findCompactCodexSession, findScopingOracle, registerFixtureHooks, firstSessionId, fmtCompactForTest, fmtCostForTest, getCostAnomalyExpectations, getFindingOracle, getTurnExpectations, gotoViewer, highestCostTurn, hmsToMsForTest, humanizeDurationForTest, join, longestWallDurationTurn, pendingFindingsForSession, readFileSync, readMetaCostForTest, readdirSync, resolve, seedCostFallbackFixtures, seedFindingFixtures, seedPrFixture, seedSubagentFixtures, statSync, test, turnCache, verdictCountForFinding, withDb } from "./helpers";
import { pickProject } from "./topbar";

registerFixtureHooks();

// Assertions are structural (counts change, classes toggle, URL changes) rather
// than tied to specific seeded titles, so they stay green as the ingested
// transcripts grow.

test.describe("Sessions surface + viewer (/)", () => {
  test("the list surface shows sessions; opening a row reveals the named viewer", async ({ page }) => {
    // bare "/" is the full-width Sessions LIST surface (left = nav only).
    await page.goto("/");
    await expect(page.locator(`[data-testid="session-list"] [data-testid="session-item"]`).first()).toBeVisible();
    // opening a row drills into the per-session WORKSPACE: named header + timeline.
    await gotoViewer(page);
    await expect(page.locator(`[data-testid="sessbar"] [data-testid="sessbar-title"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="sessbar"] [data-testid="sessbar-stats"]`)).toContainText("tokens");
    expect(await page.locator(`[data-testid="event-row"]`).count()).toBeGreaterThan(0);
  });

  test("tabs switch the centre content", async ({ page }) => {
    await gotoViewer(page);
    const tabs = page.locator(`[data-testid="tabs"] [data-testid="tab"]`);
    await tabs.filter({ hasText: "Raw JSON" }).click();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Raw JSON/);
    await tabs.filter({ hasText: "Subagents" }).click();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Subagents/);
    await tabs.filter({ hasText: "Transcript" }).click();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
    await expect(page.locator(`[data-testid="event-row"]`).first()).toBeVisible();
  });

  test("kind filter reduces the expanded steps", async ({ page }) => {
    await gotoViewer(page);
    await expandAllTurns(page);
    const before = await page.locator(`[data-testid="event-row"][data-row-kind="step"]`).count();
    expect(before).toBeGreaterThan(0);
    // the kind filter (D7's 5 kinds) lives in the transcript toolbar; in the
    // default "hide" mode, turning a kind off drops its steps from the accordion.
    await page.locator(`[data-testid="transcript-filters"] [data-testid="kind-badge"]`).first().click();
    await expect
      .poll(async () => page.locator(`[data-testid="event-row"][data-row-kind="step"]`).count())
      .toBeLessThan(before);
  });

  test("clicking a step selects it (inline detail-block)", async ({ page }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}`);
    await page.locator(`[data-testid="event-row"][data-row-kind="turn-header"]`).first().click();
    const rows = page.locator(`[data-testid="event-row"][data-row-kind="step"]`);
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    await expect(page.locator(`[data-testid="event-row"][data-row-kind="step"][data-selected="true"]`)).toHaveCount(1);
    await expect(page.locator(`[data-testid="step-detail"]`).first()).toBeVisible();
  });

  test("the surface search filters the list and clears", async ({ page }) => {
    // the search box lives on the list surface itself (no session open yet).
    await page.goto("/");
    await expect(page.locator(`[data-testid="session-list"] [data-testid="session-item"]`).first()).toBeVisible();
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
    await expect(page.locator(`[data-testid="session-list"] [data-testid="session-item"]`).first()).toBeVisible();
    await page.locator(`[data-testid="session-item"]`).first().click();
    await expect(page).toHaveURL(/\?session=/);
    // the viewer no longer carries its own session-list sidebar (navigation lives
    // in the left rail); a row click lands in the named per-session workspace.
    await expect(page.locator(`[data-testid="sessbar"] [data-testid="sessbar-title"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="event-row"]`).first()).toBeVisible();
  });

  test("Pin persists to localStorage", async ({ page }) => {
    // Pin/Note were dropped from the transcript (its detail is the inline step
    // detail-block) AND from Tools (slice 7) AND from Skills (slice 8: both are
    // now full-width comparison-lists whose invocations expand inline — no
    // inspector). They live on the Inspector for the REMAINING list+inspector
    // tabs (subagents/annotations/raw). Drive Pin from the Raw inspector: Raw
    // always renders and the viewer auto-selects the seed event, so the
    // inspector's Pin button is present + enabled for any session.
    await gotoViewer(page, "tab=raw");
    const pinBtn = page.locator(`[data-testid="lds-rightpanel"] [data-testid="btn"]`, { hasText: /Pin/i }).first();
    await expect(pinBtn).toBeEnabled();
    await pinBtn.click();
    const pins = await page.evaluate(() => localStorage.getItem("lathe.pins"));
    expect(pins && pins.length).toBeTruthy();
  });

  test("cost is derived from token usage and shown ($)", async ({ page }) => {
    // the list surface shows priceable (Opus) sessions with a real dollar amount.
    await page.goto("/");
    await expect(page.locator(`[data-testid="session-list"] [data-testid="session-item"]`).first()).toBeVisible();
    const dollarCosts = page.locator(`[data-testid="session-item"] [data-testid="chip"][data-cell="cost"]`, { hasText: "$" });
    expect(await dollarCosts.count()).toBeGreaterThan(0);
    // and the viewer header carries the matching Cost stat.
    await gotoViewer(page);
    await expect(
      page.locator(`[data-testid="sessbar-stats"] [data-testid="kstat"]`, { hasText: "cost" })
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
      await page.locator(`[data-testid="session-list"] [data-testid="session-item"]`).evaluateAll((items) =>
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
      page.locator(`[data-testid="session-item"][data-session-id="${COST_FIXTURE_IDS[1]}"] [data-anomaly="cost"]`)
    ).toHaveText("▲ cost");
    await expect(
      page.locator(`[data-testid="session-item"][data-session-id="${COST_FIXTURE_IDS[0]}"] [data-anomaly="cost"]`)
    ).toHaveCount(0);
    await expect(
      page.locator(`[data-testid="session-item"][data-session-id="${COST_FIXTURE_IDS[2]}"] [data-anomaly="cost"]`)
    ).toHaveCount(0);
  });

  test("overview surfaces the G9 cost flag in the cost-outliers list", async ({ page }) => {
    await page.goto("/overview");
    await pickProject(page, "(no edits)");
    // Overview v2 has no session rail; the anomalous session is a row in the
    // attention panel's cost-alerts column, carrying a ▲ cost flag, and links
    // straight to that session's viewer.
    const row = page.locator(`[data-attn-group="cost"] [data-testid="attn-row"][data-session-id="${COST_FIXTURE_IDS[1]}"]`
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

test.describe("Subagents tab (slice 9 — D18 [By step|All] + D17 geometry + D16 nested)", () => {
  // session known to spawn 3 distinct general-purpose runs, all inline-kids,
  // fired consecutively in one turn → a single PARALLEL block of 3 cards.
  const SID = "da2ac032-a905-4267-8e5f-851456926a79";

  test("D18: a [By step | All] view switch with a subagents count (By step default)", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    const seg = page.locator(`[data-testid="sa-view-switch"]`);
    await expect(seg).toBeVisible();
    // English labels; "By step" is the active default.
    await expect(seg.locator(`[role="tab"]`, { hasText: "By step" })).toHaveAttribute("aria-selected", "true");
    await expect(seg.locator(`[role="tab"]`, { hasText: "All" })).toBeVisible();
    // the count lives on the right of the toolbar.
    await expect(page.locator(`[data-testid="sa-toolbar-count"]`)).toContainText(/\d+ subagents/);
  });

  test("D17: same-step launchers render as a parallel horizontal card row", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    // the 3 consecutive same-turn launchers form ONE parallel block (K 件 並列).
    const block = page.locator(`[data-testid="sa-block"][data-parallel="true"]`).first();
    await expect(block).toBeVisible();
    await expect(block.locator(`[data-testid="sa-block-where"]`)).toContainText(/Turn \d+ · step \d+/);
    await expect(block.locator(`[data-testid="sa-block-count"]`)).toContainText(/parallel/);
    const cards = block.locator(`[data-testid="sa-card"]`);
    expect(await cards.count()).toBe(3);
    // a card shows [runner icon][name][cost · N tools].
    await expect(cards.first().locator(`[data-testid="sa-card-name"]`)).toContainText("general-purpose");
    await expect(cards.first().locator(`[data-testid="sa-card-meta"]`)).toContainText(/tools/);
  });

  test("D16: clicking a card expands an inline nested mini-session (3-tab, flat Step list)", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    // collapsed by default: no nested session yet.
    await expect(page.locator(`[data-testid="sa-nested"]`)).toHaveCount(0);
    const card = page.locator(`[data-testid="sa-card"]`).first();
    await card.click();
    await expect(card).toHaveAttribute("aria-expanded", "true");
    const nested = page.locator(`[data-testid="sa-nested"]`).first();
    await expect(nested).toBeVisible();
    // the nested header carries the runner name + cost·tools + a × close.
    await expect(nested.locator(`[data-testid="sa-nested-name"]`)).toContainText("general-purpose");
    await expect(nested.locator(`[data-testid="sa-nested-close"]`)).toBeVisible();
    // the 3-tab bar (Transcript / Tools / Git), Transcript active.
    const tabs = nested.locator(`[data-testid="sa-nested-tab"]`);
    expect(await tabs.count()).toBe(3);
    await expect(nested.locator(`[data-testid="sa-nested-tab"][data-nested-tab="transcript"]`)).toHaveAttribute("aria-selected", "true");
    // nested Transcript = a FLAT list of reused Step components (step 1..N).
    await expect
      .poll(async () => nested.locator(`[data-testid="sa-nested-step"]`).count())
      .toBeGreaterThan(0);
    await expect(nested.locator(`[data-testid="sa-nested-step"]`).first().locator(`[data-testid="event-row"][data-row-kind="step"]`)).toBeVisible();
  });

  test("D16: nested Tools = a comparison-list; nested Git = scoped diff", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(`[data-testid="sa-card"]`).first().click();
    const nested = page.locator(`[data-testid="sa-nested"]`).first();
    // switch to the nested Tools facet — a reused ComparisonList (sa-tool rows).
    await nested.locator(`[data-testid="sa-nested-tab"][data-nested-tab="tools"]`).click();
    await expect
      .poll(async () => nested.locator(`[data-testid="sa-tools-list"] [data-testid="sa-tool-row"]`).count())
      .toBeGreaterThan(0);
    // switch to the nested Git facet — either a scoped diff or an honest empty.
    await nested.locator(`[data-testid="sa-nested-tab"][data-nested-tab="git"]`).click();
    await expect(nested.locator(`[data-testid="sa-nested-body"][data-nested-tab="git"]`)).toBeVisible();
  });

  test("clicking the same card again (or ×) closes the nested session", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    const card = page.locator(`[data-testid="sa-card"]`).first();
    await card.click();
    await expect(page.locator(`[data-testid="sa-nested"]`)).toHaveCount(1);
    await card.click();
    await expect(page.locator(`[data-testid="sa-nested"]`)).toHaveCount(0);
  });

  test("D18 All: a comparison-list aggregate (count desc), expandable into nested sessions", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(`[data-testid="sa-view-switch"] [role="tab"]`, { hasText: "All" }).click();
    // ComparisonList appends an `s` to the list testid: prefix "sa-all" → "sa-alls-list".
    const rows = page.locator(`[data-testid="sa-alls-list"] [data-testid="sa-all-row"]`);
    await expect(rows.first()).toBeVisible();
    // the 3 general-purpose runs aggregate into one peer with count ×3.
    await expect(rows.first().locator(`[data-testid="sa-all-name"]`)).toContainText("general-purpose");
    await expect(rows.first().locator(`[data-testid="sa-all-count"]`)).toContainText("3");
    // count is non-increasing down the list (sorted desc).
    const counts = await page
      .locator(`[data-testid="sa-alls-list"] [data-testid="sa-all-count"]`)
      .evaluateAll((els) => (els as HTMLElement[]).map((e) => Number((e.textContent ?? "").replace(/[^0-9]/g, ""))));
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    // row expand reveals a nested mini-session per invocation (D16, same as By step).
    await rows.first().click();
    await expect
      .poll(async () => page.locator(`[data-testid="sa-all-body"] [data-testid="sa-nested"]`).count())
      .toBeGreaterThan(0);
  });

  test("D16 linkedChild: a linked sub-agent keeps the honest OPEN SUB-SESSION navigation", async ({ page }) => {
    await page.goto(`/?session=${SUBAGENT_FIXTURE.parentId}&tab=subagents`);
    // the fixture parent has two "explorer" launchers (one linked, one missing);
    // open cards until one expands to the OPEN SUB-SESSION navigation (NOT a
    // fabricated transcript), since the linked sub-agent's kids are not inline.
    const cards = page.locator(`[data-testid="sa-card"]`);
    const n = await cards.count();
    let open = page.locator(`[data-testid="sa-open-subsession"]`).first();
    for (let i = 0; i < n; i++) {
      await cards.nth(i).click();
      if ((await page.locator(`[data-testid="sa-open-subsession"]`).count()) > 0) {
        open = page.locator(`[data-testid="sa-open-subsession"]`).first();
        break;
      }
      await cards.nth(i).click(); // close before trying the next
    }
    await expect(open).toBeVisible();
    await open.click();
    await expect(page).toHaveURL(new RegExp(`session=${SUBAGENT_FIXTURE.childId}`));
    await expect(page.locator(`[data-testid="sessbar-title"]`)).toHaveText("Fixture linked sub-session");
  });

  test("unlinked sub-agent with no inline kids is explicit about missing internal steps", async ({ page }) => {
    await page.goto(`/?session=${SUBAGENT_FIXTURE.parentId}&tab=subagents`);
    // the unlinked launcher (agent_id → missing session, no kids) opens to a
    // nested transcript that honestly states the steps were not captured.
    const cards = page.locator(`[data-testid="sa-card"]`);
    // open each card until one shows "internal steps not captured".
    const n = await cards.count();
    let found = false;
    for (let i = 0; i < n; i++) {
      await cards.nth(i).click();
      const note = page.locator(`[data-testid="sa-nested"] [data-testid="empty"]`, { hasText: "internal steps not captured" });
      if ((await note.count()) > 0) {
        found = true;
        break;
      }
      await cards.nth(i).click(); // close before trying the next
    }
    expect(found).toBeTruthy();
  });

  test("sub-sessions are hidden from the list until the toggle is enabled", async ({
    page,
  }) => {
    // The session list (and its "show sub-sessions" toggle) lives on the Sessions
    // surface ("/") now that the per-session viewer's sidebar was removed.
    await page.goto("/");
    await expect(page.locator(`[data-testid="session-list"] [data-testid="session-item"]`).first()).toBeVisible();
    const childItem = page.locator(`[data-testid="session-list"] [data-session-id="${SUBAGENT_FIXTURE.childId}"]`
    );
    await expect(childItem).toHaveCount(0);
    // open the collapsible filters, then enable the sub-sessions toggle.
    await page.getByRole("button", { name: "Filters" }).click();
    await page.getByLabel("show sub-sessions").check();
    await expect(childItem).toBeVisible();
  });
});

test.describe("Global nav & IA axes", () => {
  for (const route of ["/", "/findings", "/chat", "/pr", "/overview"]) {
    test(`the persistent global bar is present on ${route}`, async ({ page }) => {
      await page.goto(route);
      const nav = page.locator(`[data-testid="globalnav"]`);
      await expect(nav).toBeVisible();
      // the axes are always there; Chat is surface A's full-page destination.
      await expect(nav.locator('[data-testid="globalnav-tab"][data-nav="sessions"]')).toBeVisible();
      await expect(nav.locator('[data-testid="globalnav-tab"][data-nav="findings"]')).toBeVisible();
      await expect(nav.locator('[data-testid="globalnav-tab"][data-nav="chat"]')).toBeVisible();
      await expect(nav.locator('[data-testid="globalnav-tab"][data-nav="pr"]')).toBeVisible();
      await expect(nav.locator('[data-testid="globalnav-tab"][data-nav="overview"]')).toBeVisible();
    });
  }

  test("the current axis is highlighted on each route", async ({ page }) => {
    const cases: [string, string][] = [["/", "sessions"], ["/findings", "findings"], ["/chat", "chat"], ["/pr", "pr"], ["/overview", "overview"]];
    for (const [route, nav] of cases) {
      await page.goto(route);
      const active = page.locator(`[data-testid="globalnav-tab"][data-state="active"]`);
      await expect(active).toHaveCount(1);
      await expect(active).toHaveAttribute("data-nav", nav);
    }
  });

  test("the session viewer keeps chat out of its tabs and chips", async ({ page }) => {
    await gotoViewer(page);
    // Full-page chat lives at /chat; the old in-session tab and Discuss chip stay removed.
    await expect(page.locator(`[data-testid="tabs"] [data-testid="tab"]`, { hasText: "Chat" })).toHaveCount(0);
    await expect(page.locator(`[data-testid="chat-session-chip"]`)).toHaveCount(0);
  });

  test("the Findings axis renders the cross-session master-detail and decides a verdict", async ({
    page,
  }) => {
    const oracle = await getFindingOracle();
    await page.goto("/findings");
    await expect(page.locator(`[data-testid="globalnav-tab"][data-state="active"]`)).toHaveAttribute("data-nav", "findings");

    // the same master-detail component as the tab, in axis mode
    await expect(page.locator('[data-testid="findings-tab"][data-findings-mode="axis"]')).toBeVisible();
    const row = page.locator(`[data-testid="finding-row"][data-finding-id="${oracle.id}"]`);
    await expect(row).toBeVisible();
    await row.click();
    const detail = page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`);
    await expect(detail).toBeVisible();
    await detail.locator(`[data-testid="finding-verdict-reason"]`).fill("axis verified");
    await detail.locator(`[data-testid="finding-verdict-btn"][data-verdict="accept"]`).click();
    await expect(page.locator(`[data-testid="finding-verdict-toast"][data-verdict="accept"]`)).toContainText("Accepted");
    await expect.poll(async () => verdictCountForFinding(FINDING_FIXTURE.titles.jump)).toBe(1);

    // restore the fixture to pending so the shared seed is not contaminated for
    // later tests (findings are seeded once in beforeAll).
    await page.locator(`[data-testid="finding-verdict-toast"] [data-testid="btn"]`, { hasText: "Undo" }).click();
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
    await expect(page.locator(`[data-testid="sessbar"] [data-testid="sessbar-title"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="globalnav-tab"][data-state="active"]`)).toHaveAttribute("data-nav", "sessions");
    const ownerTitle = await page.locator(`[data-testid="sessbar-title"]`).textContent();

    // switching to another session swaps the workspace to that session — no stale
    // header is left behind.
    await page.goto(`/?session=${encodeURIComponent(oracle.otherSession)}&tab=transcript`);
    await expect(page).toHaveURL(new RegExp(`session=${oracle.otherSession}`));
    await expect(page.locator(`[data-testid="sessbar"] [data-testid="sessbar-title"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="sessbar-title"]`)).not.toHaveText(ownerTitle ?? "");
    await expect(page.locator(`[data-testid="globalnav-tab"][data-state="active"]`)).toHaveAttribute("data-nav", "sessions");
  });

  test("the deep-linked session is always identifiable in its workspace header", async ({
    page,
  }) => {
    const oracle = await findScopingOracle();
    await page.goto(`/?session=${encodeURIComponent(oracle.ownerSession)}&tab=transcript`);

    // "which one am I viewing" must never be lost: with the session-list sidebar
    // gone, the sessbar header is the single source of truth and always names the
    // open session (requirement C, restated for the rail-nav IA).
    await expect(page.locator(`[data-testid="sessbar"] [data-testid="sessbar-title"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="event-row"]`).first()).toBeVisible();
  });
});

test.describe("Harness signals", () => {
  test("nested memory loads & hook firings appear in the transcript + filters", async ({
    page,
  }) => {
    await page.goto("/?session=da2ac032-a905-4267-8e5f-851456926a79");
    await expandAllTurns(page);
    // D7 groups memory → investigate and hook → execute; the kind filter (now in
    // the transcript toolbar) exposes those kinds.
    await expect(
      page.locator(`[data-testid="transcript-filters"] [data-testid="kind-badge"][data-step-kind="investigate"]`)
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="transcript-filters"] [data-testid="kind-badge"][data-step-kind="execute"]`)
    ).toBeVisible();
    // and at least one memory event renders in the timeline with its own icon
    await expect(page.locator(`[data-testid="timeline"] [data-testid="event-icon"][data-event-kind="memory"]`).first()).toBeVisible();
  });

  test("the overview Trends include findings by kind", async ({
    page,
  }) => {
    await page.goto("/overview");
    const findingsCard = page.locator(`[data-testid="trend-card"][data-trend="findings-by-kind"]`);
    await expect(findingsCard).toBeVisible();
    await expect(findingsCard.locator(`[data-testid="finding-kind-row"][data-kind="failure_loop"]`)).toBeVisible();
  });
});

test.describe("Codex support", () => {
  test("Codex sessions are ingested and shown alongside Claude (runner badge)", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.locator(`[data-testid="session-list"] [data-testid="runner-badge"]`, { hasText: "Codex" }).first()
    ).toBeVisible();
  });

  test("the overview runner trend includes Codex sessions", async ({ page }) => {
    await page.goto("/overview");
    const runnerCard = page.locator(`[data-testid="trend-card"][data-trend="cost-by-runner"]`);
    await expect(runnerCard).toBeVisible();
    await expect(runnerCard.locator(`[data-testid="runner-cost-row"][data-runner="codex"]`)).toContainText("Codex");
  });

  test("Codex skill use (reading a SKILL.md) is surfaced as a skill event", async ({
    page,
  }) => {
    // a Codex session that used the openai-docs skill by reading its SKILL.md.
    // Codex has no skill tool, so this is detected from the shell read — it must
    // still show up as a first-class skill (it was previously lost as a file_read).
    // Skills is now a capability-aggregated comparison-list (slice 8 / D33): the
    // skill name surfaces as a row, and the underlying skill event (the reused
    // Step, data-event-kind="skill") appears when the row is expanded (D12).
    await page.goto("/?session=019e9d30-e0a9-7752-b11c-70aa8644e17f&tab=skills");
    const skillRow = page
      .locator(`[data-testid="skills-list"] [data-testid="skill-row"]`)
      .filter({ hasText: /openai-docs/ })
      .first();
    await expect(skillRow).toBeVisible();
    await skillRow.click();
    await expect(
      page.locator(`[data-testid="skill-body"] [data-testid="event-icon"][data-event-kind="skill"]`).first()
    ).toBeVisible();
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
