import { COST_ANOMALY_BASELINE, COST_FIXTURE_IDS, COST_FIXTURE_PROJECT_ID, Client, CostAnomalyExpectation, DATABASE_URL, DbEvent, DbFileLink, DbSession, FINDING_FIXTURE, FindingOracle, PR_FIXTURE, SUBAGENT_FIXTURE, TurnExpectation, cleanupCostFallbackFixtures, cleanupFindingFixtures, cleanupSubagentFixtures, expandAllTurns, expect, expectTurnJump, findCompactCodexSession, findMultiFileDiffSession, findScopingOracle, registerFixtureHooks, firstSessionId, fmtCompactForTest, fmtCostForTest, getCostAnomalyExpectations, getFindingOracle, getTurnExpectations, gotoViewer, highestCostTurn, hmsToMsForTest, humanizeDurationForTest, join, longestWallDurationTurn, pendingFindingsForSession, readFileSync, readMetaCostForTest, readdirSync, resolve, seedCostFallbackFixtures, seedFindingFixtures, seedPrFixture, seedSubagentFixtures, statSync, test, turnCache, verdictCountForFinding, withDb } from "./helpers";

registerFixtureHooks();

test.describe("Cross-screen navigation & time ribbon", () => {
  test("Git is an in-page tab: diff shows in place, no navigation", async ({
    page,
  }) => {
    await gotoViewer(page);
    await page.locator(`[data-testid="tabs"] [data-testid="tab"]`, { hasText: "Git" }).click();
    // does NOT navigate away to /diff…
    await expect(page).not.toHaveURL(/\/diff/);
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Git/);
    // …the diff working area is embedded in place (no separate /diff page, and no
    // session-list sidebar — navigation lives in the left rail / Sessions surface).
    await expect(page.locator(`[data-testid="diff-embed"]`)).toBeVisible();
  });

  test("from the Git tab, other tabs switch in-page (no /diff page)", async ({ page }) => {
    await page.goto("/diff"); // redirects to /?session=…&tab=git
    await expect(page).not.toHaveURL(/\/diff/);
    await page.locator(`[data-testid="tabs"] [data-testid="tab"]`, { hasText: "Transcript" }).click();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
    await expect(page.locator(`[data-testid="timeline"] [data-testid="event-row"]`).first()).toBeVisible();
  });

  test("?tab opens the viewer on that tab", async ({ page }) => {
    await page.goto("/?tab=subagents");
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Subagents/);
  });

  test("time ribbon renders with segments on the session viewer", async ({ page }) => {
    await gotoViewer(page);
    await expect(page.locator(`[data-testid="ribbon-track"]`)).toBeVisible();
    expect(await page.locator(`[data-testid="ribbon-seg"]`).count()).toBeGreaterThan(0);
  });

  test("time ribbon zoom widens the track", async ({ page }) => {
    await gotoViewer(page);
    const track = page.locator(`[data-testid="ribbon-track"]`);
    const w0 = await track.evaluate((el) => el.style.width);
    await page.locator(`[data-testid="minimap-zoom"] button`, { hasText: "+" }).click();
    await expect.poll(async () => track.evaluate((el) => el.style.width)).not.toBe(w0);
  });
});

test.describe("Event detail panel", () => {
  test("shows compact stats (duration/exit) and a wrapping output", async ({ page }) => {
    await page.goto("/?session=da2ac032-a905-4267-8e5f-851456926a79");
    await expandAllTurns(page);
    const bashRow = page
      .locator(`[data-testid="event-row"]`)
      .filter({ has: page.locator(`[data-testid="event-icon"][data-event-kind="bash"]`) })
      .first();
    if ((await bashRow.count()) > 0) {
      await bashRow.click();
      await expect(page.locator(`[data-testid="stat-strip"] [data-testid="stat"]`).first()).toBeVisible();
      await expect(page.locator(`[data-testid="code-block"][data-block-kind="output"]`)).toBeVisible();
      const ws = await page
        .locator(`[data-testid="code-block"][data-block-kind="output"]`)
        .evaluate((el) => getComputedStyle(el).whiteSpace);
      expect(ws).toBe("pre-wrap"); // output wraps, no horizontal cut-off
      // the old tall key/value table is gone
      await expect(page.locator(`[data-testid="detail"] [data-testid="kv"] dt`)).toHaveCount(0);
    }
  });
});

test.describe("Thinking", () => {
  test("thinking events are captured and viewable", async ({ page }) => {
    // a session with extended-thinking (non-redacted) blocks
    await page.goto("/?session=b1dcf7bd-a268-4304-bc4a-b45463538aa2");
    await expandAllTurns(page);
    const trow = page
      .locator(`[data-testid="event-row"]`)
      .filter({ has: page.locator(`[data-testid="event-icon"][data-event-kind="thinking"]`) })
      .first();
    if ((await trow.count()) > 0) {
      await trow.click();
      await expect(page.locator(`[data-testid="detail-head"] [data-testid="dtitle"]`)).toHaveText(/Thinking/);
      const body = (await page.locator(`[data-testid="code-block"][data-block-kind="output"]`).innerText()).trim();
      expect(body.length).toBeGreaterThan(0);
    }
  });
});

test.describe("Sub-agent expansion", () => {
  test("sub-agent rows expand to reveal child steps (tools/skills)", async ({ page }) => {
    // a session known to spawn general-purpose sub-agents
    await page.goto("/?session=da2ac032-a905-4267-8e5f-851456926a79");
    await expandAllTurns(page);
    // pick the expander on a SUB-AGENT row (not a turn-header user_message —
    // they now share the .tw-expand class for ▾/▸ toggles).
    const saExpander = page
      .locator(`[data-testid="event-row"]:not([data-row-kind="turn-header"])`)
      .filter({ has: page.locator(`[data-testid="event-icon"][data-event-kind="subagent"]`) })
      .first()
      .locator(`[data-testid="tw-expand"]`);
    if ((await saExpander.count()) > 0) {
      const before = await page.locator(`[data-testid="event-row"]`).count();
      await saExpander.click();
      await expect
        .poll(async () => page.locator(`[data-testid="event-row"][data-child-row="true"]`).count())
        .toBeGreaterThan(0);
      expect(await page.locator(`[data-testid="event-row"]`).count()).toBeGreaterThan(before);
      // a child step should be a real tool/message of the sub-agent
      await expect(page.locator(`[data-testid="event-row"][data-child-row="true"]`).first()).toBeVisible();
    }
  });
});

test.describe("Time ribbon & annotations", () => {
  test("ribbon: hovering reads out the exact time + step", async ({ page }) => {
    await gotoViewer(page);
    const track = page.locator(`[data-testid="ribbon-track"]`);
    await expect(track).toBeVisible();
    const box = await track.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
      await expect(page.locator(`[data-testid="ribbon-read"]`)).toContainText(/\d{2}:\d{2}:\d{2}/);
    }
  });

  test("ribbon: clicking the track selects the step at the cursor", async ({ page }) => {
    await gotoViewer(page);
    const track = page.locator(`[data-testid="ribbon-track"]`);
    const box = await track.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
      await expect(page.locator(`[data-testid="event-row"][data-selected="true"]`)).toHaveCount(1);
    }
  });

  test("ribbon: zooming in adds more time-axis ticks", async ({ page }) => {
    await gotoViewer(page);
    const before = await page.locator(`[data-testid="ribbon-axis"] [data-testid="tick"]`).count();
    await page.locator(`[data-testid="minimap-zoom"] button`, { hasText: "+" }).click();
    await page.locator(`[data-testid="minimap-zoom"] button`, { hasText: "+" }).click();
    await expect
      .poll(async () => page.locator(`[data-testid="ribbon-axis"] [data-testid="tick"]`).count())
      .toBeGreaterThan(before);
  });

  test("annotations are labelled (kind + step) and jump on click", async ({ page }) => {
    // a session with errors + commits flagged — annotations now live in their
    // own top-level tab (moved out of the right aside, which was context-wrong).
    await page.goto("/?session=4912b75c-6018-427c-b67b-00a583404d21&tab=annotations");
    const ann = page.locator(`[data-panel="annotations"] [data-testid="annotation"]`).first();
    if ((await ann.count()) > 0) {
      await expect(ann.locator(`[data-testid="akind-tag"]`)).toBeVisible();
      await expect(ann.locator(`[data-testid="aseq"]`)).toContainText(/step/);
      await ann.click();
      // clicking jumps INTO the Transcript tab and selects the step there
      await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
      await expect(page.locator(`[data-testid="event-row"][data-selected="true"]`)).toHaveCount(1);
    }
  });
});

test.describe("Annotations tab (moved out of the right aside)", () => {
  // session known to carry flagged moments (errors + commits)
  const SID = "4912b75c-6018-427c-b67b-00a583404d21";

  test("there is an Annotations tab with a count badge, and the aside no longer hosts annotations", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=annotations`);
    const tab = page.locator(`[data-testid="tabs"] [data-testid="tab"]`, { hasText: "Annotations" });
    await expect(tab).toBeVisible();
    const count = await page.locator(`[data-panel="annotations"] [data-testid="annotation"]`).count();
    if (count > 0) {
      // count badge reflects the number of flagged moments
      await expect(tab.locator(`[data-testid="tab-count"]`)).toHaveText(String(count));
    }
    // the old right-aside annotations strip is gone everywhere
    await expect(page.locator(`[data-testid="aside"] [data-testid="annotations-strip"]`)).toHaveCount(0);
  });

  test("annotations are listed in time order (at_seq ascending)", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=annotations`);
    const seqs = await page
      .locator(`[data-panel="annotations"] [data-testid="annotation"]`)
      .evaluateAll((rows) =>
        (rows as HTMLElement[]).map((r) => Number(r.getAttribute("data-annotation-seq")))
      );
    if (seqs.length > 1) {
      const sorted = [...seqs].sort((a, b) => a - b);
      expect(seqs).toEqual(sorted);
    }
  });
});

test.describe("Turn-first explorer", () => {
  const SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";
  const SUBAGENT_SID = "da2ac032-a905-4267-8e5f-851456926a79";

  test("initial transcript view shows turn headers only", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    await expect(page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="turn-header"]`).first()).toBeVisible();
    await expect.poll(async () => page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"]`).count()).toBe(0);
  });

  test("turn headers show rollup values from the real session data", async ({ page }) => {
    const first = (await getTurnExpectations(SID))[0];
    await page.goto(`/?session=${SID}`);
    const row = page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="turn-header"][data-turn="${first.turn}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-rollup-steps", String(first.steps));
    await expect(row).toHaveAttribute("data-rollup-edits", String(first.edits));
    await expect(row).toHaveAttribute("data-rollup-errors", String(first.errors));
    await expect(row).toHaveAttribute("data-rollup-files", String(first.files.length));
    await expect(row).toContainText(`${first.steps} step`);
    await expect(row).toContainText(`${first.edits} edits`);
    await expect(row).toContainText(`${first.errors} errors`);
    await expect(row).toContainText(fmtCostForTest(first.costUsd));
    await expect(row).toContainText(fmtCompactForTest(first.tokens));
    await expect(row).toContainText(humanizeDurationForTest(first.durationMs));
    await expect(row).toContainText(`${first.files.length} files`);
  });

  test("turns with errors carry the error emphasis hook", async ({ page }) => {
    const errorTurn = (await getTurnExpectations(SID)).find((t) => t.errors > 0);
    expect(errorTurn).toBeTruthy();
    await page.goto(`/?session=${SID}`);
    const row = page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="turn-header"][data-turn="${errorTurn!.turn}"]`);
    await expect(row).toHaveAttribute("data-turn-has-error", "true");
  });

  test("turn row click expands and collapses; sub-agent nesting still expands", async ({ page }) => {
    await page.goto(`/?session=${SUBAGENT_SID}`);
    const firstHeader = page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="turn-header"]`).first();
    await firstHeader.click();
    await expect.poll(async () => page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"]`).count()).toBeGreaterThan(0);
    await firstHeader.click();
    await expect.poll(async () => page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"]`).count()).toBe(0);

    await expandAllTurns(page);
    const saExpander = page
      .locator(`[data-testid="event-row"][data-row-kind="step"]`)
      .filter({ has: page.locator(`[data-testid="event-icon"][data-event-kind="subagent"]`) })
      .first()
      .locator(`[data-testid="tw-expand"]`);
    if ((await saExpander.count()) > 0) {
      await saExpander.click();
      await expect
        .poll(async () => page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-child-row="true"]`).count())
        .toBeGreaterThan(0);
    }
  });

  test("expanded step rows expose proportional time bars", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    await expandAllTurns(page);
    const bars = page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"] [data-testid="step-timebar"]`);
    await expect(bars.first()).toBeVisible();
    const values = await bars.evaluateAll((els) =>
      els
        .map((el) => ({
          duration: Number((el as HTMLElement).dataset.durationMs || 0),
          width: Number((el as HTMLElement).dataset.widthPct || 0),
        }))
        .filter((v) => v.duration > 0)
    );
    expect(values.length).toBeGreaterThan(0);
    const shortest = values.reduce((a, b) => (a.duration <= b.duration ? a : b));
    const longest = values.reduce((a, b) => (a.duration >= b.duration ? a : b));
    expect(longest.width).toBeGreaterThanOrEqual(shortest.width);
  });

  test("turn files chip opens the active diff file; touched steps jump back", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    const chip = page.locator(`[data-testid="timeline"] [data-testid="chip"][data-file-id]`).first();
    await expect(chip).toBeVisible();
    const fileId = await chip.getAttribute("data-file-id");
    expect(fileId).toBeTruthy();
    await chip.click();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Git/);
    await expect(page.locator(`[data-testid="file-row"][data-active="true"][data-file-id="${fileId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="file-touched-steps"]`)).toBeVisible();
    await page.locator(`[data-testid="file-touched-step"]`).first().click();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
    await expect(page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-selected="true"]`)).toHaveCount(1);
  });

  test("event type filters can highlight or hide non-matching steps", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    await expandAllTurns(page);
    // filters moved from the left sidebar into the transcript toolbar.
    await page.locator(`[data-testid="filter-mode"] button`, { hasText: "Highlight" }).click();
    await page.locator(`[data-testid="transcript-filters"] [data-testid="event-type-badge"][data-event-kind="bash"]`).click();
    await expect
      .poll(async () => page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"][data-dimmed="true"]`).count())
      .toBeGreaterThan(0);
    expect(await page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"] [data-testid="event-icon"][data-event-kind="bash"]`).count()).toBeGreaterThan(0);
    await page.locator(`[data-testid="filter-mode"] button`, { hasText: "Hide" }).click();
    await expect.poll(async () => page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"] [data-testid="event-icon"][data-event-kind="bash"]`).count()).toBe(0);
  });
});

test.describe("Transcript: turn grouping", () => {
  // multi-turn Claude session (41 turns) — Collapse turns must reduce the row
  // count to exactly the turn-header count, Expand turns must restore them.
  const SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";

  test("turn headers carry the Turn N · M steps chip", async ({ page }) => {
    const first = (await getTurnExpectations(SID))[0];
    await page.goto(`/?session=${SID}`);
    await expect(page.locator(`[data-testid="event-row"][data-row-kind="turn-header"]`).first()).toBeVisible();
    await expect(page.locator(`[data-testid="chip"][data-chip-kind="turn"]`).first()).toContainText(/Turn 1\b/);
    await expect(page.locator(`[data-testid="event-row"][data-row-kind="turn-header"]`).first()).toContainText(`${first.steps} step`);
  });

  test("Expand turns restores step rows; Collapse turns returns to turn headers only", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    const headers = await page.locator(`[data-testid="event-row"][data-row-kind="turn-header"]`).count();
    expect(headers).toBeGreaterThan(1);
    await expect.poll(async () => page.locator(`[data-testid="event-row"]`).count()).toBe(headers);
    await page.locator(`[data-testid="turn-filter"] button`, { hasText: "Expand turns" }).click();
    await expect
      .poll(async () => page.locator(`[data-testid="event-row"]`).count())
      .toBeGreaterThan(headers);
    await page.locator(`[data-testid="turn-filter"] button`, { hasText: "Collapse turns" }).click();
    await expect.poll(async () => page.locator(`[data-testid="event-row"]`).count()).toBe(headers);
  });
});

test.describe("Inspector (RightPanel) reopen", () => {
  // An INTERACTION invariant the geometry gate can't catch: it needs a click
  // flow. The Inspector (Surface RightPanel) closes with ×; before the fix there
  // was NO control to bring it back, so closing it stranded the user until a page
  // reload. This pins down close → reopen-control-appears → reopen → panel-back.
  // The non-transcript, non-full-width tabs (tools/skills/subagents/raw) render
  // the RightPanel; we use the tools tab.
  test("closing the Inspector reveals a reopen control that restores it", async ({ page }) => {
    // discover a real seeded session via the existing helper, opened on the
    // tools inspector tab (no hardcoded id).
    await gotoViewer(page, "tab=tools");

    const rightpanel = page.locator(`[data-testid="lds-rightpanel"]`);
    const close = page.locator(`[data-testid="lds-rp-close"]`);
    const reopen = page.locator(`[data-testid="lds-rp-reopen"]`);

    // 1. the Inspector starts open; no reopen control yet.
    await expect(rightpanel).toBeVisible();
    await expect(reopen).toBeHidden();

    // 2. close it — the panel goes away.
    await close.click();
    await expect(rightpanel).toBeHidden();

    // 3. the reopen control is now visible (the affordance that was missing).
    await expect(reopen).toBeVisible();

    // 4. clicking it brings the Inspector back.
    await reopen.click();
    await expect(rightpanel).toBeVisible();
    await expect(reopen).toBeHidden();
  });
});
