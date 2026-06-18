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
    const files = page.locator(`[data-testid="file-row"]:not([class~="is-folder"])`);
    const count = await files.count();
    for (let i = 0; i < count; i++) {
      const f = files.nth(i);
      const cls = (await f.getAttribute("class")) || "";
      if (!cls.includes("active")) {
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
    // scope to the view-mode toggle (a separate .segmented.step-filter may exist)
    const viewToggle = page.locator(`[data-testid="diff-toolbar"] [class~="segmented"]:not([class~="step-filter"])`);
    await viewToggle.locator("button", { hasText: "Split" }).click();
    await expect(viewToggle.locator(`button.active`)).toHaveText(/Split/);
    await expect.poll(async () => diff.innerHTML()).not.toBe(before);
  });

  test("folder twisty collapses its children", async ({ page }) => {
    await page.goto("/diff");
    const folders = page.locator(`[data-testid="file-row"][class~="is-folder"]`);
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
    await expect(page.locator(`[data-testid="tabs"] [class~="tab"][class~="active"]`)).toHaveText(/Git/);
  });
});

test.describe("Changed-files tree (compact folders)", () => {
  // session with files nested 8+ levels deep down single-child chains
  const SID = "78a6e038-3829-43bb-98c8-404e8afa8ccc";

  test("single-child folder chains collapse; rows ≈ files, not a row per dir level", async ({
    page,
  }) => {
    await page.goto(`/diff?session=${SID}`);
    await expect(page.locator(`[data-testid="filetree-head"] [class~="sub"]`)).toHaveText(/5 files changed/);
    // exactly the 5 real files appear as file rows...
    await expect(page.locator(`[data-testid="file-row"][class~="is-file"]`)).toHaveCount(5);
    // ...and the whole tree stays compact (no per-directory-level explosion)
    expect(await page.locator(`[data-testid="file-row"]`).count()).toBeLessThanOrEqual(10);
    // a deep chain is merged into ONE folder row whose name carries the "/"-joined path
    const merged = page
      .locator(`[data-testid="file-row"][class~="is-folder"] [class~="fname"]`)
      .filter({ hasText: "/" });
    expect(await merged.count()).toBeGreaterThan(0);
  });

  test("files and folders are visually distinct (status chip vs folder icon)", async ({
    page,
  }) => {
    await page.goto(`/diff?session=${SID}`);
    // files carry a colored A/M/D status chip; folders carry a folder icon, no chip
    await expect(page.locator(`[data-testid="file-row"][class~="is-file"] [class~="status-chip"]`).first()).toBeVisible();
    expect(await page.locator(`[data-testid="file-row"][class~="is-folder"] [class~="ficon"][class~="folder"] svg`).count()).toBeGreaterThan(0);
    expect(await page.locator(`[data-testid="file-row"][class~="is-folder"] [class~="status-chip"]`).count()).toBe(0);
  });
});

test.describe("Transcript ⇄ Git cross-links", () => {
  // an edit-heavy Claude session, so attributed hunks definitely exist
  const SID = "144d8b23-cb28-4208-9b0c-98dfa585a741";

  test("an edit jumps to its diff, and the diff jumps back to the producing step", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}`);
    await expandAllTurns(page);
    // select a file-edit step in the transcript
    await page.waitForSelector('[data-testid="event-row"] [data-testid="event-icon"]');
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="event-row"]')];
      const row = rows.find((candidate) =>
        candidate
          .querySelector('[data-testid="event-icon"]')
          ?.classList.contains("file_edit"),
      );
      if (!row) throw new Error("no file-edit row found");
      row.click();
    });
    // its detail panel offers a jump to the Git diff this edit produced
    const diffBtn = page.locator(`[data-testid="detail-actions"] [class~="btn"]`, { hasText: /Diff/ });
    await expect(diffBtn).toBeVisible();
    await diffBtn.click();
    // now on the Git tab, diff embedded, with a linked-event back-link
    await expect(page.locator(`[data-testid="tabs"] [class~="tab"][class~="active"]`)).toHaveText(/Git/);
    await expect(page.locator(`[data-testid="diff-embed"]`)).toBeVisible();
    const back = page.locator(`[data-testid="le-jump"]`).first();
    await expect(back).toBeVisible();
    // the back-link returns to the transcript with an event selected
    await back.click();
    await expect(page.locator(`[data-testid="tabs"] [class~="tab"][class~="active"]`)).toHaveText(/Transcript/);
    await expect(page.locator(`[data-testid="event-row"][class~="selected"]`)).toHaveCount(1);
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
    await expect(page.locator(`[data-testid="diff-hunk"][class~="collapsed"]`).first()).toBeVisible();
    expect(await page.locator(`[data-testid="diff-hunk"][class~="collapsed"]`).count()).toBeGreaterThan(0);
    await expect(page.locator(`[data-testid="step-filter"]`)).toBeVisible();
    // "All changes" expands every hunk
    await page.locator(`[data-testid="step-filter"] button`, { hasText: "All changes" }).click();
    await expect.poll(async () => page.locator(`[data-testid="diff-hunk"][class~="collapsed"]`).count()).toBe(0);
    // "This step" collapses other turns again
    await page.locator(`[data-testid="step-filter"] button`, { hasText: "This step" }).click();
    await expect.poll(async () => page.locator(`[data-testid="diff-hunk"][class~="collapsed"]`).count()).toBeGreaterThan(0);
  });
});
