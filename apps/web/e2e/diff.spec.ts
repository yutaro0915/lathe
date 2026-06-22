import { COST_ANOMALY_BASELINE, COST_FIXTURE_IDS, COST_FIXTURE_PROJECT_ID, Client, CostAnomalyExpectation, DATABASE_URL, DbEvent, DbFileLink, DbSession, FINDING_FIXTURE, FindingOracle, PR_FIXTURE, SUBAGENT_FIXTURE, TurnExpectation, cleanupCostFallbackFixtures, cleanupFindingFixtures, cleanupSubagentFixtures, expandAllTurns, expect, expectTurnJump, findCompactCodexSession, findMultiFileDiffSession, findScopingOracle, registerFixtureHooks, firstSessionId, fmtCompactForTest, fmtCostForTest, getCostAnomalyExpectations, getFindingOracle, getTurnExpectations, gotoViewer, highestCostTurn, hmsToMsForTest, humanizeDurationForTest, join, longestWallDurationTurn, pendingFindingsForSession, readFileSync, readMetaCostForTest, readdirSync, resolve, seedCostFallbackFixtures, seedFindingFixtures, seedPrFixture, seedSubagentFixtures, statSync, test, turnCache, verdictCountForFinding, withDb } from "./helpers";

registerFixtureHooks();

test.describe("Diff viewer (/diff)", () => {
  test("loads with changed files and a diff", async ({ page }) => {
    await page.goto("/diff");
    await expect(page.locator(`[data-testid="file-row"]`).first()).toBeVisible();
    expect(await page.locator(`[data-testid="diff-hunk"]`).count()).toBeGreaterThan(0);
  });

  test("selecting a file updates the diff path", async ({ page }) => {
    const sessionId = await findMultiFileDiffSession();
    await page.goto(`/diff?session=${encodeURIComponent(sessionId)}`);
    const before = await page.locator(`[data-testid="fpath"]`).innerText();
    const files = page.locator(`[data-testid="file-row"][data-row-kind="file"]`);
    const count = await files.count();
    for (let i = 0; i < count; i++) {
      const f = files.nth(i);
      const isActive = (await f.getAttribute("data-active")) === "true";
      if (!isActive) {
        await f.click();
        break;
      }
    }
    await expect(page.locator(`[data-testid="fpath"]`)).not.toHaveText(before);
  });

  test("unified/split toggle changes the diff layout", async ({ page }) => {
    await page.goto("/diff");
    const diff = page.locator(`[data-testid="diff"]`);
    const before = await diff.innerHTML();
    // scope to the view-mode toggle (a separate step-filter segmented may exist)
    const viewToggle = page.locator(`[data-testid="diff-toolbar"] [data-testid="segmented"]`);
    await viewToggle.locator("button", { hasText: "Split" }).click();
    await expect(viewToggle.locator(`[role="tab"][aria-selected="true"]`)).toHaveText(/Split/);
    await expect.poll(async () => diff.innerHTML()).not.toBe(before);
  });

  test("folder twisty collapses its children", async ({ page }) => {
    await page.goto("/diff");
    const folders = page.locator(`[data-testid="file-row"][data-row-kind="folder"]`);
    if ((await folders.count()) > 0) {
      const before = await page.locator(`[data-testid="file-row"]`).count();
      await folders.first().click();
      await expect
        .poll(async () => page.locator(`[data-testid="file-row"]`).count())
        .toBeLessThan(before);
    }
  });

  test("Raw JSON button reveals the event JSON", async ({ page }) => {
    await page.goto("/diff");
    const btn = page.locator(`[data-testid="btn"]`, { hasText: /Raw JSON/i }).first();
    if ((await btn.count()) > 0) {
      const preBefore = await page.locator("pre").count();
      await btn.click();
      await expect.poll(async () => page.locator("pre").count()).toBeGreaterThan(preBefore);
    }
  });

  test("linked events stack (meta below title, no le-right overlap)", async ({ page }) => {
    await page.goto("/diff");
    const le = page.locator(`[data-testid="linked-event"]`).first();
    if ((await le.count()) > 0) {
      await expect(le.locator(`[data-testid="le-turn"]`)).toHaveCount(1);
      await expect(le.locator(`[data-testid="le-meta"]`)).toHaveCount(1);
      // old overlapping layout used .le-right; it must be gone
      await expect(le.locator(`[data-testid="le-right"]`)).toHaveCount(0);
    }
  });

  test("the Git tab embeds the diff in the per-session workspace", async ({ page }) => {
    await page.goto("/diff"); // redirects to /?session=…&tab=git
    // the diff is embedded in the workspace (the session-list sidebar was removed;
    // session switching now lives on the Sessions surface "/").
    await expect(page).toHaveURL(/session=.*tab=git/);
    await expect(page.locator(`[data-testid="diff-embed"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Git/);
  });
});

test.describe("Changed-files tree (compact folders)", () => {
  // session with files nested 8+ levels deep down single-child chains
  const SID = "78a6e038-3829-43bb-98c8-404e8afa8ccc";

  test("single-child folder chains collapse; rows ≈ files, not a row per dir level", async ({
    page,
  }) => {
    await page.goto(`/diff?session=${SID}`);
    await expect(page.locator(`[data-testid="filetree-head"] [data-testid="sub"]`)).toHaveText(/5 files changed/);
    // exactly the 5 real files appear as file rows...
    await expect(page.locator(`[data-testid="file-row"][data-row-kind="file"]`)).toHaveCount(5);
    // ...and the whole tree stays compact (no per-directory-level explosion)
    expect(await page.locator(`[data-testid="file-row"]`).count()).toBeLessThanOrEqual(10);
    // a deep chain is merged into ONE folder row whose name carries the "/"-joined path
    const merged = page
      .locator(`[data-testid="file-row"][data-row-kind="folder"] [data-testid="fname"]`)
      .filter({ hasText: "/" });
    expect(await merged.count()).toBeGreaterThan(0);
  });

  test("files and folders are visually distinct (status chip vs folder icon)", async ({
    page,
  }) => {
    await page.goto(`/diff?session=${SID}`);
    // files carry a colored A/M/D status chip; folders carry a folder icon, no chip
    await expect(page.locator(`[data-testid="file-row"][data-row-kind="file"] [data-testid="status-chip"]`).first()).toBeVisible();
    expect(await page.locator(`[data-testid="file-row"][data-row-kind="folder"] [data-testid="ficon"][data-ficon-kind="folder"] svg`).count()).toBeGreaterThan(0);
    expect(await page.locator(`[data-testid="file-row"][data-row-kind="folder"] [data-testid="status-chip"]`).count()).toBe(0);
  });
});

test.describe("Transcript ⇄ Git cross-links", () => {
  // an edit-heavy Claude session, so attributed hunks definitely exist
  const SID = "144d8b23-cb28-4208-9b0c-98dfa585a741";

  test("an edit step shows its diff inline; Git jumps back to the producing step", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}`);
    await expandAllTurns(page);
    // an edit step shows its file diff INLINE in its own detail-block (D6/D8 —
    // the forward transcript→Git "Diff →" button was retired with the wide
    // master-detail; the edit's diff is now viewable in place).
    const editStep = page
      .locator(`[data-testid="event-row"][data-row-kind="step"][data-step-kind="edit"]`)
      .first();
    await expect(editStep).toBeVisible();
    await editStep.click();
    await expect(page.locator(`[data-testid="step-detail"] [data-testid="step-diff"]`).first()).toBeVisible();

    // the REVERSE link is still wired: from the Git tab, a linked-event back-link
    // returns to the transcript and selects the producing step.
    await page.locator(`[data-testid="tabs"] [data-testid="tab"]`, { hasText: "Git" }).click();
    await expect(page.locator(`[data-testid="diff-embed"]`)).toBeVisible();
    const back = page.locator(`[data-testid="le-jump"]`).first();
    if ((await back.count()) > 0) {
      await back.click();
      await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
      await expect(page.locator(`[data-testid="event-row"][data-selected="true"]`)).toHaveCount(1);
    }
  });
});

test.describe("Git diff: step focus", () => {
  // a session whose primary changed file has hunks from multiple turns
  const SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";

  test("other turns' hunks collapse; All changes expands; This step re-collapses", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=git`);
    // by default the selected step's hunk is expanded; other turns collapse
    await expect(page.locator(`[data-testid="diff-hunk"][data-hunk-state="collapsed"]`).first()).toBeVisible();
    expect(await page.locator(`[data-testid="diff-hunk"][data-hunk-state="collapsed"]`).count()).toBeGreaterThan(0);
    await expect(page.locator(`[data-testid="step-filter"]`)).toBeVisible();
    // "All changes" expands every hunk
    await page.locator(`[data-testid="step-filter"] button`, { hasText: "All changes" }).click();
    await expect.poll(async () => page.locator(`[data-testid="diff-hunk"][data-hunk-state="collapsed"]`).count()).toBe(0);
    // "This step" collapses other turns again
    await page.locator(`[data-testid="step-filter"] button`, { hasText: "This step" }).click();
    await expect.poll(async () => page.locator(`[data-testid="diff-hunk"][data-hunk-state="collapsed"]`).count()).toBeGreaterThan(0);
  });
});
