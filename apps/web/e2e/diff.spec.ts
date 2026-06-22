import { COST_ANOMALY_BASELINE, COST_FIXTURE_IDS, COST_FIXTURE_PROJECT_ID, Client, CostAnomalyExpectation, DATABASE_URL, DbEvent, DbFileLink, DbSession, FINDING_FIXTURE, FindingOracle, PR_FIXTURE, SUBAGENT_FIXTURE, TurnExpectation, cleanupCostFallbackFixtures, cleanupFindingFixtures, cleanupSubagentFixtures, expandAllTurns, expect, expectTurnJump, findCompactCodexSession, findMultiFileDiffSession, findScopingOracle, registerFixtureHooks, firstSessionId, fmtCompactForTest, fmtCostForTest, getCostAnomalyExpectations, getFindingOracle, getTurnExpectations, gotoViewer, highestCostTurn, hmsToMsForTest, humanizeDurationForTest, join, longestWallDurationTurn, pendingFindingsForSession, readFileSync, readMetaCostForTest, readdirSync, resolve, seedCostFallbackFixtures, seedFindingFixtures, seedPrFixture, seedSubagentFixtures, statSync, test, turnCache, verdictCountForFinding, withDb } from "./helpers";

registerFixtureHooks();

// Slice 10 (ADR-git-single-column): the Git diff is a SINGLE-COLUMN ACCORDION —
// a [By step | By file] segmented over the same diff data, unified-only
// (side-by-side dropped), with inline ↗ Turn N · edit attribution (the le-jump,
// D14) and the +/− coloring confined to the renderer (D13). The old three-pane
// workspace (file tree + diff pane + attribution pane), the split toggle, the
// folder tree, and the raw-JSON toggle are gone; these tests assert the new UI.
// Every assertion is DETERMINISTIC and UNCONDITIONAL (no `if (count>0)` guards).
test.describe("Diff viewer (/diff)", () => {
  test("loads with changed files; the first file is open and shows a unified hunk", async ({ page }) => {
    await page.goto("/diff");
    // the single-column accordion renders a flat list of changed-file rows.
    const firstFile = page.locator(`[data-testid="file-row"][data-row-kind="file"]`).first();
    await expect(firstFile).toBeVisible();
    // the first file is open by default, so its unified hunks render inline.
    await expect(firstFile).toHaveAttribute("data-active", "true");
    expect(await page.locator(`[data-testid="diff-hunk"]`).count()).toBeGreaterThan(0);
    expect(await page.locator(`[data-testid="diff-line"]`).count()).toBeGreaterThan(0);
  });

  test("By file is the default axis; clicking a closed file toggles its hunks inline", async ({ page }) => {
    const sessionId = await findMultiFileDiffSession();
    await page.goto(`/diff?session=${encodeURIComponent(sessionId)}`);
    // By file is the active axis by default (per the mockup).
    const axis = page.locator(`[data-testid="diff-axis-switch"]`);
    await expect(axis.locator(`[role="tab"][aria-selected="true"]`)).toHaveText(/By file/);
    await expect(page.locator(`[data-testid="diff-acc-list"]`)).toHaveAttribute("data-axis", "by-file");
    // pick a CLOSED file (the first file opens by default; a multi-file session
    // guarantees a second, closed one) and toggle it open → its hunks appear.
    await expect(page.locator(`[data-testid="file-row"][data-row-kind="file"]`).first()).toBeVisible();
    const target = page.locator(`[data-testid="file-row"][data-row-kind="file"]:not([data-active="true"])`).first();
    const fileId = await target.getAttribute("data-file-id");
    const body = page.locator(`[data-testid="diff-acc-file"][data-file-id="${fileId}"] [data-testid="diff-acc-body"]`);
    await expect(body).toHaveCount(0);
    await target.click();
    await expect(body).toHaveCount(1);
    await expect(body.locator(`[data-testid="diff-hunk"]`).first()).toBeVisible();
  });

  test("the [By step | By file] axis switch flips the organization (same diff data)", async ({ page }) => {
    await page.goto(`/diff?session=33a47290-fc24-47bc-b624-e7fbc4412ade`);
    const axis = page.locator(`[data-testid="diff-axis-switch"]`);
    // start on By file → flat file rows, no step groups.
    await expect(page.locator(`[data-testid="diff-acc-list"]`)).toHaveAttribute("data-axis", "by-file");
    expect(await page.locator(`[data-testid="file-row"][data-row-kind="file"]`).count()).toBeGreaterThan(0);
    await expect(page.locator(`[data-testid="step-row"]`)).toHaveCount(0);
    // flip to By step → step-group rows appear, the flat file rows are gone. This
    // session attributes its diff to multiple producing steps, so there is more
    // than one step group.
    await axis.locator(`button[data-axis="by-step"]`).click();
    await expect(axis.locator(`[role="tab"][aria-selected="true"]`)).toHaveText(/By step/);
    await expect(page.locator(`[data-testid="diff-acc-list"]`)).toHaveAttribute("data-axis", "by-step");
    expect(await page.locator(`[data-testid="step-row"]`).count()).toBeGreaterThan(1);
    await expect(page.locator(`[data-testid="file-row"][data-row-kind="file"]`)).toHaveCount(0);
    // flip back to By file → flat file rows return.
    await axis.locator(`button[data-axis="by-file"]`).click();
    await expect(page.locator(`[data-testid="diff-acc-list"]`)).toHaveAttribute("data-axis", "by-file");
    expect(await page.locator(`[data-testid="file-row"][data-row-kind="file"]`).count()).toBeGreaterThan(0);
  });

  test("D13: added lines get the success bg, removed get danger — confined to the renderer", async ({ page }) => {
    await page.goto(`/diff?session=144d8b23-cb28-4208-9b0c-98dfa585a741`);
    // index.md is a MODIFIED file (it has both added AND removed lines), so its
    // hunk body exercises both diff colors. Open it explicitly.
    const indexRow = page
      .locator(`[data-testid="file-row"][data-row-kind="file"]`)
      .filter({ has: page.locator(`[data-testid="fpath"]`, { hasText: /\/index\.md$/ }) });
    await expect(indexRow).toHaveCount(1);
    const fileId = await indexRow.getAttribute("data-file-id");
    await indexRow.click();
    const indexFile = page.locator(`[data-testid="diff-acc-file"][data-file-id="${fileId}"]`);
    // assert the +/− coloring lands on the diff LINES (the renderer), inside this
    // file's own body. Added and removed lines each carry a tint (a real bg color,
    // not transparent) and the two tints differ (green vs red, D13).
    const added = indexFile.locator(`[data-testid="diff-line"][data-line-kind="add"]`).first();
    const removed = indexFile.locator(`[data-testid="diff-line"][data-line-kind="del"]`).first();
    await expect(added).toBeVisible();
    await expect(removed).toBeVisible();
    const transparent = "rgba(0, 0, 0, 0)";
    const addBg = await added.evaluate((el) => getComputedStyle(el).backgroundColor);
    const delBg = await removed.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(addBg).not.toBe(transparent);
    expect(delBg).not.toBe(transparent);
    expect(addBg).not.toBe(delBg);
    // …and the coloring does NOT leak onto the file ROW (D13: renderer-only). The
    // row's own background must not be an add/del bg.
    const rowBg = await indexRow.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(rowBg).not.toBe(addBg);
    expect(rowBg).not.toBe(delBg);
  });

  test("the diff body is a horizontal scroll pane for long code lines (data-scroll)", async ({ page }) => {
    await page.goto("/diff");
    // unified code lines can't wrap; the diff body keeps data-scroll so long lines
    // pan inside the box (the no-overflow gate exempts data-scroll panes). React
    // serializes the boolean prop as data-scroll="true"; the gate keys off its
    // PRESENCE (dataset.scroll != null), so any value satisfies the exemption.
    await expect(page.locator(`[data-testid="diff"]`).first()).toHaveAttribute("data-scroll", "true");
  });

  test("the diffstat header reports files / +adds / −dels", async ({ page }) => {
    const sessionId = await findMultiFileDiffSession();
    await page.goto(`/diff?session=${encodeURIComponent(sessionId)}`);
    const stat = page.locator(`[data-testid="diffstat"]`);
    await expect(stat).toBeVisible();
    await expect(stat.locator(`[data-testid="diffstat-files"]`)).toHaveText(/\d+ files/);
    await expect(stat.locator(`[data-testid="diffstat-add"]`)).toHaveText(/^\+\d/);
    await expect(stat.locator(`[data-testid="diffstat-del"]`)).toHaveText(/^−\d/);
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

test.describe("Diff viewer (By file — flat list + inline attribution)", () => {
  // an edit-heavy Claude session: a flat list of changed files, several attributed.
  const SID = "144d8b23-cb28-4208-9b0c-98dfa585a741";

  test("By file is a FLAT list of files (no folder tree rows)", async ({ page }) => {
    await page.goto(`/diff?session=${SID}`);
    // every row in the By-file list is a FILE row — the folder hierarchy was
    // dropped (the mockup shows a flat file list). The number of file rows equals
    // the number of distinct changed files (one row per file, no per-dir rows).
    const fileRows = page.locator(`[data-testid="file-row"][data-row-kind="file"]`);
    await expect(fileRows.first()).toBeVisible();
    expect(await fileRows.count()).toBeGreaterThan(1);
    // there is exactly one file row per distinct file path: assert no row carries
    // a folder kind (the old data-row-kind="folder" no longer exists).
    await expect(page.locator(`[data-testid="file-row"][data-row-kind="folder"]`)).toHaveCount(0);
    const distinctPaths = await withDb(async (client) =>
      (
        await client.query<{ n: string }>(
          `SELECT COUNT(DISTINCT path) AS n FROM changed_files WHERE session_id = $1`,
          [SID],
        )
      ).rows[0].n,
    );
    await expect(fileRows).toHaveCount(Number(distinctPaths));
  });

  test("an attributed file shows its inline ↗ Turn N · edit attribution + diffstat", async ({ page }) => {
    await page.goto(`/diff?session=${SID}`);
    // index.md is the most-heavily-attributed file in this fixture session, so its
    // row carries the inline ↗ attribution (the le-jump) unconditionally. There is
    // exactly one changed file whose full path ends in /index.md.
    const indexRow = page
      .locator(`[data-testid="file-row"][data-row-kind="file"]`)
      .filter({ has: page.locator(`[data-testid="fpath"]`, { hasText: /\/index\.md$/ }) });
    await expect(indexRow).toHaveCount(1);
    // the inline attribution link (D14) is present on the row, pointing at a step.
    const attr = indexRow.locator(`[data-testid="le-jump"]`);
    await expect(attr).toBeVisible();
    await expect(attr).toHaveText(/↗ Turn \d+ · /);
    // …and the diffstat (+adds −dels) is present on the same row.
    const stat = indexRow.locator(`[data-testid="fstats"]`);
    await expect(stat.locator(`[data-testid="add"]`)).toHaveText(/^\+\d/);
    await expect(stat.locator(`[data-testid="del"]`)).toHaveText(/^−\d/);
  });
});

test.describe("Transcript ⇄ Git cross-links", () => {
  // an edit-heavy Claude session, so attributed hunks definitely exist
  const SID = "144d8b23-cb28-4208-9b0c-98dfa585a741";

  test("an edit step shows its diff inline; Git's ↗ attribution jumps back to the producing step", async ({
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

    // the REVERSE link is still wired: from the Git tab, the file row's inline ↗
    // attribution (the le-jump, D14) returns to the transcript and selects the
    // producing step.
    await page.locator(`[data-testid="tabs"] [data-testid="tab"]`, { hasText: "Git" }).click();
    await expect(page.locator(`[data-testid="diff-embed"]`)).toBeVisible();
    // index.md is the most-heavily-attributed file in this fixture session, so its
    // row's inline ↗ attribution is guaranteed to render. There is exactly one
    // changed file whose full path ends in /index.md.
    const linkedFileRow = page
      .locator(`[data-testid="file-row"][data-row-kind="file"]`)
      .filter({ has: page.locator(`[data-testid="fpath"]`, { hasText: /\/index\.md$/ }) });
    await expect(linkedFileRow).toHaveCount(1);
    // the back-link is a KEPT feature: DiffFileRow renders one le-jump per
    // attributed file whenever onJumpToEvent is wired (SessionViewer passes a real
    // one). Assert it UNCONDITIONALLY — a regression that drops the link must fail.
    const back = linkedFileRow.locator(`[data-testid="le-jump"]`);
    await expect(back).toBeVisible();
    await back.click();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
    await expect(page.locator(`[data-testid="event-row"][data-selected="true"]`)).toHaveCount(1);
  });
});

test.describe("Git diff: By step axis", () => {
  // a session whose diff is attributed across multiple producing steps
  const SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";

  test("By step groups files by producing step; a step's ↗ jumps back to the transcript", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=git`);
    await page.locator(`[data-testid="diff-axis-switch"] button[data-axis="by-step"]`).click();
    // multiple producing steps → multiple step-group rows.
    const groups = page.locator(`[data-testid="diff-step-group"]`);
    await expect(groups.first()).toBeVisible();
    expect(await groups.count()).toBeGreaterThan(1);
    // one group opens by default (the first file's producing step). Pick a CLOSED
    // group, PIN it by its step-key (so the locator stays stable after it opens),
    // and expand it → it lists the file diffs that step produced, same hunks.
    const stepKey = await page
      .locator(`[data-testid="diff-step-group"]:not([data-open="true"])`)
      .first()
      .getAttribute("data-step-key");
    const closedGroup = page.locator(`[data-testid="diff-step-group"][data-step-key="${stepKey}"]`);
    await closedGroup.locator(`[data-testid="step-row"]`).click();
    await expect(closedGroup).toHaveAttribute("data-open", "true");
    const body = closedGroup.locator(`[data-testid="step-body"]`);
    await expect(body).toBeVisible();
    await expect(body.locator(`[data-testid="step-file"]`).first()).toBeVisible();
    await expect(body.locator(`[data-testid="diff-hunk"]`).first()).toBeVisible();
    // the step group's ↗ (le-jump, D14) returns to the transcript and selects the
    // producing step. Assert it UNCONDITIONALLY (attributed step groups carry it).
    const jump = closedGroup.locator(`[data-testid="step-row"] [data-testid="le-jump"]`);
    await expect(jump).toBeVisible();
    await jump.click();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
    await expect(page.locator(`[data-testid="event-row"][data-selected="true"]`)).toHaveCount(1);
  });
});
