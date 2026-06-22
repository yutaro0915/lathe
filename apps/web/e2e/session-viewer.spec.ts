import { expandAllTurns, expect, getTurnExpectations, gotoViewer, registerFixtureHooks, test } from "./helpers";

registerFixtureHooks();

test.describe("Cross-screen navigation", () => {
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
    // the transcript renders its turn-accordion (turn-header cards).
    await expect(page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="turn-header"]`).first()).toBeVisible();
  });

  test("?tab opens the viewer on that tab", async ({ page }) => {
    await page.goto("/?tab=subagents");
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Subagents/);
  });
});

test.describe("Step detail-block (inline)", () => {
  // D6/D8: clicking a step expands its detail-block IN PLACE (no side pane). The
  // output is READABLE (the user wants outputs viewable in the transcript) and
  // WRAPS (no horizontal cut-off). This replaces the retired wide master-detail.
  test("an execute step expands a wrapping output detail-block", async ({ page }) => {
    await page.goto("/?session=da2ac032-a905-4267-8e5f-851456926a79");
    await expandAllTurns(page);
    const execStep = page
      .locator(`[data-testid="event-row"][data-row-kind="step"][data-step-kind="execute"]`)
      .first();
    if ((await execStep.count()) > 0) {
      await execStep.click();
      // the inline detail-block appears below the step (not a side pane).
      const output = page.locator(`[data-testid="step-detail"] [data-testid="code-block"][data-block-kind="output"]`).first();
      await expect(output).toBeVisible();
      const ws = await output.evaluate((el) => getComputedStyle(el).whiteSpace);
      expect(ws).toBe("pre-wrap"); // output wraps, no horizontal cut-off
      // there is NO old wide detail pane / narrow inspector aside on the transcript.
      await expect(page.locator(`[data-testid="lds-sv-tx-detail"]`)).toHaveCount(0);
      await expect(page.locator(`[data-testid="lds-rightpanel"]`)).toHaveCount(0);
    }
  });

  test("a thinking step expands its full body inline", async ({ page }) => {
    // a session with extended-thinking (non-redacted) blocks
    await page.goto("/?session=b1dcf7bd-a268-4304-bc4a-b45463538aa2");
    await expandAllTurns(page);
    const trow = page
      .locator(`[data-testid="event-row"][data-row-kind="step"][data-step-kind="thinking"]`)
      .first();
    if ((await trow.count()) > 0) {
      await trow.click();
      // the thinking body renders inline (markdown), readable in place.
      const body = page.locator(`[data-testid="step-detail"] [data-testid="step-detail-body"]`).first();
      await expect(body).toBeVisible();
      const text = (await body.innerText()).trim();
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

test.describe("Sub-agent nesting", () => {
  test("a sub-agent step expands to reveal its child steps", async ({ page }) => {
    // a session known to spawn general-purpose sub-agents
    await page.goto("/?session=da2ac032-a905-4267-8e5f-851456926a79");
    await expandAllTurns(page);
    const saExpander = page
      .locator(`[data-testid="event-row"][data-row-kind="step"]`)
      .filter({ has: page.locator(`[data-testid="event-icon"][data-event-kind="subagent"]`) })
      .first()
      .locator(`[data-testid="tw-expand"]`);
    if ((await saExpander.count()) > 0) {
      const before = await page.locator(`[data-testid="event-row"][data-row-kind="step"]`).count();
      await saExpander.click();
      await expect
        .poll(async () => page.locator(`[data-testid="event-row"][data-child-row="true"]`).count())
        .toBeGreaterThan(0);
      expect(await page.locator(`[data-testid="event-row"][data-row-kind="step"]`).count()).toBeGreaterThan(before);
      // a nested child step renders as a real Step of the sub-agent.
      await expect(page.locator(`[data-testid="event-row"][data-child-row="true"]`).first()).toBeVisible();
    }
  });
});

test.describe("Annotations tab", () => {
  // session known to carry flagged moments (errors + commits)
  const SID = "4912b75c-6018-427c-b67b-00a583404d21";

  test("annotations are labelled (kind + step) and jump on click", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=annotations`);
    const ann = page.locator(`[data-panel="annotations"] [data-testid="annotation"]`).first();
    if ((await ann.count()) > 0) {
      await expect(ann.locator(`[data-testid="akind-tag"]`)).toBeVisible();
      await expect(ann.locator(`[data-testid="aseq"]`)).toContainText(/step/);
      await ann.click();
      // clicking jumps INTO the Transcript tab and selects the step there (its
      // owning turn auto-expands so the step is visible inline).
      await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
      await expect(page.locator(`[data-testid="event-row"][data-row-kind="step"][data-selected="true"]`)).toHaveCount(1);
    }
  });

  test("there is an Annotations tab with a count badge", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=annotations`);
    const tab = page.locator(`[data-testid="tabs"] [data-testid="tab"]`, { hasText: "Annotations" });
    await expect(tab).toBeVisible();
    const count = await page.locator(`[data-panel="annotations"] [data-testid="annotation"]`).count();
    if (count > 0) {
      await expect(tab.locator(`[data-testid="tab-count"]`)).toHaveText(String(count));
    }
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

test.describe("Tools tab = comparison-list + inline expansion (D11/D12/D8)", () => {
  // session with a healthy spread of tool invocations across types
  const SID = "da2ac032-a905-4267-8e5f-851456926a79";

  test("Tools renders one row per tool type, sorted by invocation count (desc)", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=tools`);
    const rows = page.locator(`[data-testid="tools-list"] [data-testid="tool-row"]`);
    await expect(rows.first()).toBeVisible();
    // counts are non-increasing down the list (D11 sort = count descending).
    const counts = await page
      .locator(`[data-testid="tools-list"] [data-testid="tool-count"]`)
      .evaluateAll((els) => (els as HTMLElement[]).map((e) => Number((e.textContent ?? "").replace(/[^0-9]/g, ""))));
    expect(counts.length).toBeGreaterThan(0);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    // Tools is full-width now (D12: no side inspector for Tools).
    await expect(page.locator(`[data-testid="lds-rightpanel"]`)).toHaveCount(0);
  });

  test("clicking a tool type row expands its invocations inline as Step rows", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=tools`);
    const firstRow = page.locator(`[data-testid="tools-list"] [data-testid="tool-row"]`).first();
    await expect(firstRow).toBeVisible();
    // collapsed by default: no invocation Steps inside the body yet.
    await expect(page.locator(`[data-testid="tool-body"] [data-testid="event-row"][data-row-kind="step"]`)).toHaveCount(0);
    await firstRow.click();
    // expanded: the invocations appear inline as reused Step components (D8).
    await expect
      .poll(async () => page.locator(`[data-testid="tool-body"] [data-testid="event-row"][data-row-kind="step"]`).count())
      .toBeGreaterThan(0);
    await expect(firstRow).toHaveAttribute("aria-expanded", "true");
    // clicking again collapses it in place (D12).
    await firstRow.click();
    await expect(page.locator(`[data-testid="tool-body"] [data-testid="event-row"][data-row-kind="step"]`)).toHaveCount(0);
  });
});

test.describe("Turn accordion (D6)", () => {
  const SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";
  const SUBAGENT_SID = "da2ac032-a905-4267-8e5f-851456926a79";

  test("turns are collapsed by default — only turn headers show", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    await expect(page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="turn-header"]`).first()).toBeVisible();
    await expect.poll(async () => page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"]`).count()).toBe(0);
  });

  test("turn headers carry Turn N + summary + step count + rollup data", async ({ page }) => {
    const first = (await getTurnExpectations(SID))[0];
    await page.goto(`/?session=${SID}`);
    const row = page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="turn-header"][data-turn="${first.turn}"]`);
    await expect(row).toBeVisible();
    await expect(row.locator(`[data-testid="chip"][data-chip-kind="turn"]`)).toContainText(/Turn 1\b/);
    await expect(row.locator(`[data-testid="turn-steps"]`)).toContainText(`${first.steps} step`);
    await expect(row.locator(`[data-testid="turn-summary"]`)).toBeVisible();
    await expect(row).toHaveAttribute("data-rollup-steps", String(first.steps));
    await expect(row).toHaveAttribute("data-rollup-edits", String(first.edits));
    await expect(row).toHaveAttribute("data-rollup-errors", String(first.errors));
  });

  test("turns with errors carry the error emphasis hook", async ({ page }) => {
    const errorTurn = (await getTurnExpectations(SID)).find((t) => t.errors > 0);
    expect(errorTurn).toBeTruthy();
    await page.goto(`/?session=${SID}`);
    const row = page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="turn-header"][data-turn="${errorTurn!.turn}"]`);
    await expect(row).toHaveAttribute("data-turn-has-error", "true");
  });

  test("clicking a turn header expands and collapses its steps in place", async ({ page }) => {
    await page.goto(`/?session=${SUBAGENT_SID}`);
    const firstHeader = page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="turn-header"]`).first();
    await firstHeader.locator(`[data-testid="turn-head"]`).click();
    await expect.poll(async () => page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"]`).count()).toBeGreaterThan(0);
    await firstHeader.locator(`[data-testid="turn-head"]`).click();
    await expect.poll(async () => page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"]`).count()).toBe(0);
  });

  test("Expand turns / Collapse turns toggle every turn", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    const headers = await page.locator(`[data-testid="event-row"][data-row-kind="turn-header"]`).count();
    expect(headers).toBeGreaterThan(1);
    await expect.poll(async () => page.locator(`[data-testid="event-row"][data-row-kind="step"]`).count()).toBe(0);
    await page.locator(`[data-testid="turn-filter"] button`, { hasText: "Expand turns" }).click();
    await expect
      .poll(async () => page.locator(`[data-testid="event-row"][data-row-kind="step"]`).count())
      .toBeGreaterThan(0);
    await page.locator(`[data-testid="turn-filter"] button`, { hasText: "Collapse turns" }).click();
    await expect.poll(async () => page.locator(`[data-testid="event-row"][data-row-kind="step"]`).count()).toBe(0);
  });

  test("a step opens its detail-block; a sub-agent step still nests", async ({ page }) => {
    await page.goto(`/?session=${SUBAGENT_SID}`);
    await expandAllTurns(page);
    const step = page.locator(`[data-testid="event-row"][data-row-kind="step"]`).first();
    await step.click();
    await expect(page.locator(`[data-testid="step-detail"]`).first()).toBeVisible();

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
});

test.describe("Transcript: kind filter (D7)", () => {
  const SID = "33a47290-fc24-47bc-b624-e7fbc4412ade";

  test("the 5 step kinds are offered as filter chips", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    for (const kind of ["thinking", "investigate", "execute", "edit", "message"]) {
      await expect(
        page.locator(`[data-testid="transcript-filters"] [data-testid="kind-badge"][data-step-kind="${kind}"]`)
      ).toBeVisible();
    }
  });

  test("kind filter can highlight or hide non-matching steps", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    await expandAllTurns(page);
    // Highlight mode: turning off a kind DIMS its steps but keeps them visible.
    await page.locator(`[data-testid="filter-mode"] button`, { hasText: "Highlight" }).click();
    await page.locator(`[data-testid="transcript-filters"] [data-testid="kind-badge"][data-step-kind="execute"]`).click();
    await expect
      .poll(async () => page.locator(`[data-testid="timeline"] [data-dimmed="true"]`).count())
      .toBeGreaterThan(0);
    expect(
      await page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"][data-step-kind="execute"]`).count()
    ).toBeGreaterThan(0);
    // Hide mode: the execute steps drop out of the accordion entirely.
    await page.locator(`[data-testid="filter-mode"] button`, { hasText: "Hide" }).click();
    await expect
      .poll(async () => page.locator(`[data-testid="timeline"] [data-testid="event-row"][data-row-kind="step"][data-step-kind="execute"]`).count())
      .toBe(0);
  });

  test("text search narrows the visible steps", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    await expandAllTurns(page);
    const before = await page.locator(`[data-testid="event-row"][data-row-kind="step"]`).count();
    expect(before).toBeGreaterThan(0);
    await page.locator(`[data-testid="search"] input`).fill("zzzunlikelyqueryzzz");
    await expect
      .poll(async () => page.locator(`[data-testid="event-row"][data-row-kind="step"]`).count())
      .toBeLessThan(before);
  });
});

test.describe("Inspector (RightPanel) collapse/expand toggle", () => {
  // An INTERACTION invariant the geometry gate can't catch: it needs a click
  // flow. The Inspector (Surface RightPanel) used to close with a header × and
  // reopen with a SEPARATE edge rail — two asymmetric controls. Now ONE edge
  // toggle (lds-rp-toggle) handles both directions. The transcript dropped the
  // RightPanel (its detail is inline) and Tools dropped it too (slice 7: Tools
  // is now a full-width comparison-list with inline expansion), so this uses the
  // Raw tab — a non-transcript, non-full-width tab that still renders the inspector.
  test("the Inspector collapses and re-expands via one consistent edge toggle", async ({ page }) => {
    await gotoViewer(page, "tab=raw");

    const rightpanel = page.locator(`[data-testid="lds-rightpanel"]`);
    const toggle = page.locator(`[data-testid="lds-rp-toggle"]`);

    await expect(rightpanel).toBeVisible();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await toggle.click();
    await expect(rightpanel).toBeHidden();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();
    await expect(rightpanel).toBeVisible();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});
