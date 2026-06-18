import { COST_ANOMALY_BASELINE, COST_FIXTURE_IDS, COST_FIXTURE_PROJECT_ID, Client, CostAnomalyExpectation, DATABASE_URL, DbEvent, DbFileLink, DbSession, FINDING_FIXTURE, FindingOracle, PR_FIXTURE, SUBAGENT_FIXTURE, TurnExpectation, cleanupCostFallbackFixtures, cleanupFindingFixtures, cleanupSubagentFixtures, expandAllTurns, expect, expectTurnJump, findCompactCodexSession, findMultiFileDiffSession, findScopingOracle, registerFixtureHooks, firstSessionId, fmtCompactForTest, fmtCostForTest, getCostAnomalyExpectations, getFindingOracle, getTurnExpectations, gotoViewer, highestCostTurn, hmsToMsForTest, humanizeDurationForTest, join, longestWallDurationTurn, pendingFindingsForSession, readFileSync, readMetaCostForTest, readdirSync, resolve, seedCostFallbackFixtures, seedFindingFixtures, seedPrFixture, seedSubagentFixtures, statSync, test, turnCache, verdictCountForFinding, withDb } from "./helpers";

registerFixtureHooks();

test.describe("Findings tab and verdict oracle", () => {
  test("fixture findings are listed and the pending badge matches the DB oracle", async ({
    page,
  }) => {
    const oracle = await getFindingOracle();
    // the tab is session-scoped, so its badge = pending findings ON THIS session
    // (not the project-wide pending total).
    const sessionPending = await pendingFindingsForSession(FINDING_FIXTURE.sessionId);
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);

    const tab = page.locator(`[data-testid="tabs"] [data-testid="tab"]`, { hasText: "Findings" });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab.locator(`[data-testid="tab-count"]`)).toHaveText(String(sessionPending));

    const row = page.locator(`[data-testid="finding-row"][data-finding-id="${oracle.id}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-kind", oracle.kind);
    await expect(row).toHaveAttribute("data-analyst", oracle.analyst);
    await expect(row).toHaveAttribute("data-verdict", "pending");
    await expect(row).toHaveAttribute("data-evidence-count", String(oracle.evidence_count));
    await expect(row).toContainText(FINDING_FIXTURE.titles.jump);

    // master-detail: list rows carry NO accept/reject button — the decision
    // lives in the detail panel only, so it is never made from the list alone.
    await expect(row.locator(`[data-testid="finding-verdict-btn"]`)).toHaveCount(0);
  });

  test("clicking a list row opens its detail panel with verdict controls", async ({
    page,
  }) => {
    const title = FINDING_FIXTURE.titles.verdict;
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);

    const row = page.locator(`[data-testid="finding-row"]`, { hasText: title });
    await row.click();
    await expect(row).toHaveAttribute("aria-pressed", "true");

    const detail = page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`);
    await expect(detail).toContainText(title);
    await expect(detail.locator(`[data-testid="finding-verdict-btn"][data-verdict="accept"]`)).toBeVisible();
    await expect(detail.locator(`[data-testid="finding-verdict-btn"][data-verdict="reject"]`)).toBeVisible();
  });

  test("Accept with a short reason inserts a verdict and Undo removes it", async ({
    page,
  }) => {
    const title = FINDING_FIXTURE.titles.jump;
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);

    await page.locator(`[data-testid="finding-row"]`, { hasText: title }).click();
    const detail = page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`);
    await detail.locator(`[data-testid="finding-verdict-reason"]`).fill("valid fixture");
    await detail.locator(`[data-testid="finding-verdict-btn"][data-verdict="accept"]`).click();

    await expect(page.locator(`[data-testid="finding-verdict-toast"][data-verdict="accept"]`)).toContainText("Accepted");
    await expect.poll(async () => verdictCountForFinding(title)).toBe(1);

    await page.locator(`[data-testid="finding-verdict-toast"] [data-testid="btn"]`, { hasText: "Undo" }).click();
    await expect.poll(async () => verdictCountForFinding(title)).toBe(0);
    await expect(page.locator(`[data-testid="finding-row"]`, { hasText: title })).toHaveAttribute("data-verdict", "pending");
  });

  test("verdict completion stays within one selecting click plus typing and Enter", async ({
    page,
  }) => {
    const title = FINDING_FIXTURE.titles.verdict;
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);

    // open the detail panel for this finding (the one click the flow needs)…
    await page.locator(`[data-testid="finding-row"]`, { hasText: title }).click();
    const detail = page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`);
    await expect(detail).toContainText(title);

    // …then count any FURTHER clicks: the verdict itself must complete with no
    // additional button click — just typing a reason and pressing Enter.
    await page.evaluate(() => {
      (window as typeof window & { __findingClicks?: number }).__findingClicks = 0;
      document.addEventListener(
        "click",
        (event) => {
          const target = event.target;
          if (target instanceof Element && target.closest(".findings-tab")) {
            (window as typeof window & { __findingClicks?: number }).__findingClicks =
              ((window as typeof window & { __findingClicks?: number }).__findingClicks ?? 0) + 1;
          }
        },
        { capture: true, once: false }
      );
    });

    const input = detail.locator(`[data-testid="finding-verdict-reason"]`);
    await input.fill("enter accepted");
    await input.press("Enter");

    await expect.poll(async () => verdictCountForFinding(title)).toBe(1);
    const clicks = await page.evaluate(
      () => (window as typeof window & { __findingClicks?: number }).__findingClicks ?? 0
    );
    expect(clicks).toBe(0);
  });

  test("detail evidence excerpt shows the evidence command from the seq", async ({ page }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    // turn-kind evidence with a { seq } locator — the analyst's real contract.
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const detail = page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`);
    const card = detail.locator('[data-testid="finding-evidence-card"][data-evidence-kind="turn"]');
    await expect(card).toHaveAttribute("data-resolved", "true");
    // the seq-2 fixture event is `pnpm test` exiting 1 — its command must render.
    await expect(card.locator(`[data-testid="finding-excerpt"]`)).toContainText("pnpm test");
    // the step number now rides the step row header (session-wide step index).
    await expect(card.locator(`[data-testid="finding-evidence-stepno"]`)).toContainText("STEP 2");
    await expect(card.locator(`[data-testid="finding-evidence-exit"]`)).toContainText("exit 1");
  });

  test("seq-locator turn evidence jumps to and flashes the transcript step", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const detail = page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`);
    await detail.locator('[data-testid="finding-evidence-card"][data-evidence-kind="turn"] [data-testid="finding-evidence"][data-resolved="true"]').click();

    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
    const target = page.locator(`[data-testid="event-row"][data-eid="${FINDING_FIXTURE.eventId}"]`);
    await expect(target).toHaveAttribute("data-selected", "true");
    await expect(target).toHaveAttribute("data-flash", "true");
  });

  test("evidence clicks activate the transcript step and the diff hunk", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.jump }).click();
    const detail = page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`);

    await detail.locator('[data-testid="finding-evidence-card"][data-evidence-kind="event"] [data-testid="finding-evidence"][data-resolved="true"]').click();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
    await expect(page.locator(`[data-testid="event-row"][data-selected="true"][data-eid="${FINDING_FIXTURE.eventId}"]`)).toBeVisible();

    await page.locator(`[data-testid="tabs"] [data-testid="tab"]`, { hasText: "Findings" }).click();
    // the detail panel keeps the same finding selected, so the hunk evidence
    // card is still present — its jump opens the Git tab on that hunk.
    await detail.locator('[data-testid="finding-evidence-card"][data-evidence-kind="hunk"] [data-testid="finding-evidence"][data-resolved="true"]').click();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Git/);
    await expect(page.locator(`[data-testid="file-row"][data-active="true"][data-file-id="${FINDING_FIXTURE.fileId}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="diff-hunk"][data-hunk-state="active"][data-hunk-id="${FINDING_FIXTURE.hunkId}"]`)).toBeVisible();
  });

  test("the Findings tab drops the right event inspector and hands it the full width", async ({
    page,
  }) => {
    // On Transcript the event detail is now a WIDE master-detail in the body
    // (annotation #6 / design row #6): a scannable event list on the LEFT and a
    // dominant detail on the RIGHT — NOT the old narrow RightPanel. The detail
    // (`aside`) is meaningfully WIDER than the list, so Input/Output + md preview
    // + code get real width.
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=transcript`);
    await expect(page.locator(`[data-testid="lds-sv-tx-detail"] [data-testid="aside"]`)).toBeVisible();
    const listWidth = await page
      .locator(`[data-testid="lds-sv-tx-list"]`)
      .evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const detailWidth = await page
      .locator(`[data-testid="lds-sv-tx-detail"]`)
      .evaluate((el) => Math.round(el.getBoundingClientRect().width));
    // the wide detail dominates the list (the important info is not cramped).
    expect(detailWidth).toBeGreaterThan(listWidth);
    const surfaceBody = await page
      .locator(`[data-testid="lds-surface-body"]`)
      .evaluate((el) => Math.round(el.getBoundingClientRect().width));
    // the transcript body is not split into a narrow RightPanel inspector.
    await expect(page.locator(`[data-testid="lds-surface-split"]`)).toHaveCount(0);

    // …on Findings the inspector aside is removed entirely and the whole
    // work-area width goes to the findings master-detail (informs no verdict).
    await page.locator(`[data-testid="tabs"] [data-testid="tab"]`, { hasText: "Findings" }).click();
    await expect(page.locator(`[data-testid="main"]`)).toHaveAttribute("data-tab", "findings");
    await expect(page.locator(`[data-testid="aside"]`)).toHaveCount(0);
    await expect(page.locator(`[data-testid="lds-surface-split"]`)).toHaveCount(0);
    const mainFindings = await page
      .locator(`[data-testid="main"]`)
      .evaluate((el) => Math.round(el.getBoundingClientRect().width));
    expect(mainFindings).toBeGreaterThan(surfaceBody * 0.9); // full work-area width
  });

  test("session tab evidence: NO SESSION header, but turn position + USER ASKED + AFTERWARD", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    // the turn-seq finding points at the seq-2 failing command — a deterministic
    // anchor for the surrounding story in the fixture.
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const card = page
      .locator(`[data-testid="finding-detail"][data-detail-finding-id]`)
      .locator('[data-testid="finding-evidence-card"][data-evidence-kind="turn"]');
    await expect(card).toHaveAttribute("data-resolved", "true");

    // requirement A: inside the session viewer every finding already belongs to
    // this session, so the SESSION header (title / runner / start time) is noise
    // and is suppressed.
    await expect(card.locator(`[data-testid="finding-evidence-session"]`)).toHaveCount(0);

    // …but the turn POSITION that used to ride on the session meta line moves to
    // the group header, so "where in the run" is still legible.
    await expect(card.locator(`[data-testid="finding-evidence-grouphead"] [data-testid="finding-evidence-position"]`)).toContainText(
      "turn 1/1"
    );

    // USER ASKED — the nearest preceding user prompt (seq 1 in the fixture).
    const trigger = card.locator(`[data-testid="finding-evidence-trigger"]`);
    await expect(trigger).toContainText("Please inspect the fixture.");
    await expect(trigger.locator(`[data-testid="finding-evidence-trigger-seq"]`)).toContainText("step 1");

    // evidence — the step's excerpt still renders the failing command.
    await expect(card.locator(`[data-testid="finding-excerpt"]`)).toContainText("pnpm test");

    // AFTERWARD — failure_loop escapes to the next non-failure event (the seq-3
    // assistant message in the fixture).
    const after = card.locator(`[data-testid="finding-evidence-after"]`);
    await expect(after).toHaveAttribute("data-after-seq", "3");
    await expect(after).toContainText("The fixture command failed once.");
  });

  test("the cross-session axis DOES show the SESSION header (it spans many runs)", async ({
    page,
  }) => {
    await page.goto("/findings");
    await page.locator(`[data-testid="findings-filter"] button`, { hasText: "All" }).click();
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const card = page
      .locator(`[data-testid="finding-detail"][data-detail-finding-id]`)
      .locator('[data-testid="finding-evidence-card"][data-evidence-kind="turn"]');
    const session = card.locator(`[data-testid="finding-evidence-session"]`);
    await expect(session).toHaveAttribute("data-session-id", FINDING_FIXTURE.sessionId);
    await expect(session.locator(`[data-testid="finding-evidence-session-title"]`)).toContainText(
      "Fixture findings session"
    );
    await expect(session.locator(`[data-testid="finding-evidence-session-meta"]`)).toContainText("Codex");
  });

  test("evidence in the same (session, turn) collapses into ONE group with one row per step", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.grouped }).click();
    const detail = page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`);

    // two same-turn evidence rows (seqs 2 and 3) → exactly ONE group card…
    const cards = detail.locator(`[data-testid="finding-evidence-card"]`);
    await expect(cards).toHaveCount(1);
    const card = cards.first();
    await expect(card).toHaveAttribute("data-group-size", "2");

    // …carrying a mono repeat count…
    await expect(card.locator(`[data-testid="finding-evidence-repeats"]`)).toContainText("×2 repeats");

    // …USER ASKED shown once for the whole group…
    await expect(card.locator(`[data-testid="finding-evidence-trigger"]`)).toHaveCount(1);

    // …and one STEP row per seq, in time order (236-style session-wide step no.).
    const steps = card.locator(`[data-testid="finding-evidence-step"]`);
    await expect(steps).toHaveCount(2);
    await expect(steps.nth(0).locator(`[data-testid="finding-evidence-stepno"]`)).toContainText("STEP 2");
    await expect(steps.nth(1).locator(`[data-testid="finding-evidence-stepno"]`)).toContainText("STEP 3");
    // the step number is annotated with what "step" means (session-wide index).
    await expect(steps.nth(0).locator(`[data-testid="finding-evidence-stepno"]`)).toHaveAttribute(
      "title",
      /Session-wide step number/
    );

    // AFTERWARD appears once, at the end of the group (not per step).
    await expect(card.locator(`[data-testid="finding-evidence-after"]`)).toHaveCount(1);
  });
});

// ---- triage: jump actions + embedded transcript + sticky verdict + layout ---
// The Findings detail becomes a triage surface: jump to the session / turn,
// read the surrounding transcript inline, decide without scrolling past it, and
// never have the layout shift under selection (design/ui-design-language.md).
test.describe("Findings triage (jumps, embedded transcript, sticky verdict, layout)", () => {
  // ① the SESSION header (axis) jumps to that session's transcript
  test("clicking the SESSION header opens the session viewer transcript", async ({ page }) => {
    await page.goto("/findings");
    await page.locator(`[data-testid="findings-filter"] button`, { hasText: "All" }).click();
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const card = page
      .locator(`[data-testid="finding-detail"][data-detail-finding-id]`)
      .locator('[data-testid="finding-evidence-card"][data-evidence-kind="turn"]');
    const sessionJump = card.locator(`[data-testid="finding-evidence-session"]`);
    await expect(sessionJump).toHaveAttribute("data-session-id", FINDING_FIXTURE.sessionId);
    await sessionJump.click();
    // lands on the owning session's viewer, on the Transcript tab
    await expect(page).toHaveURL(new RegExp(`session=${FINDING_FIXTURE.sessionId}`));
    await expect(page).toHaveURL(/tab=transcript/);
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
  });

  // ② the TURN header row jumps to the transcript positioned at that turn
  test("clicking the TURN position jumps to that turn's step in the transcript", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const card = page
      .locator(`[data-testid="finding-detail"][data-detail-finding-id]`)
      .locator('[data-testid="finding-evidence-card"][data-evidence-kind="turn"]');
    const turnJump = card.locator(`[data-testid="finding-evidence-action-turn"]`);
    await expect(turnJump).toHaveAttribute("data-turn", "1");
    await expect(turnJump).toHaveText(/VIEW TURN/);
    await turnJump.click();
    // same session → in-page: transcript tab active and the turn-head step (seq 1,
    // the USER ASKED prompt) is selected + flashed.
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
    const head = page.locator(`[data-testid="event-row"][data-eid="${FINDING_FIXTURE.sessionId}-event-1"]`);
    await expect(head).toHaveAttribute("data-selected", "true");
  });

  // ⑤ expanding an evidence group reveals the inline turn transcript rows
  test("expanding the inline transcript shows the turn's event rows inline", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    // the grouped finding folds two same-turn steps into one card; the fixture
    // session's turn 1 has 4 top-level events (seqs 1/2/3/4).
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.grouped }).click();
    const card = page.locator(`[data-testid="finding-detail"][data-detail-finding-id] [data-testid="finding-evidence-card"]`).first();

    const toggle = card.locator(`[data-testid="finding-evidence-turn-toggle"]`);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    const transcript = card.locator(`[data-testid="finding-turn-transcript"]`);
    await expect(transcript).toBeVisible();
    // the four turn-1 events render as compact rows…
    const rows = transcript.locator(`[data-testid="finding-turn-event"]`);
    await expect(rows).toHaveCount(4);
    // …the failing bash step (seq 2) shows its command + non-zero exit and is
    // flagged as this finding's own evidence.
    const evRow = transcript.locator('[data-testid="finding-turn-event"][data-seq="2"]');
    await expect(evRow).toHaveAttribute("data-evidence", "true");
    await expect(evRow.locator(`[data-testid="finding-turn-event-cmd"]`)).toContainText("pnpm test");
    await expect(evRow.locator(`[data-testid="finding-turn-event-exit"]`)).toContainText("exit 1");
    // the duplicate "open in session" link inside the embed is gone (requirement
    // C): VIEW TURN / VIEW SESSION in the group header are the single way out.
    await expect(transcript.locator(`[data-testid="finding-turn-open"]`)).toHaveCount(0);
    await expect(card.locator(`[data-testid="finding-evidence-action-session"]`)).toBeVisible();

    // clicking an inline row deep-links to that exact step in the transcript
    await evRow.click();
    await expect(page.locator(`[data-testid="tabs"] [role="tab"][aria-selected="true"]`)).toHaveText(/Transcript/);
    await expect(page.locator(`[data-testid="event-row"][data-selected="true"][data-eid="${FINDING_FIXTURE.eventId}"]`)).toBeVisible();
  });

  // ③ the verdict bar is visible without scrolling even with long evidence
  test("the verdict bar stays pinned to the panel bottom (sticky) over long evidence", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    // pick a PENDING finding so the Accept/Reject controls render…
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.grouped }).click();
    const detail = page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`);
    const accept = detail.locator(`[data-testid="finding-verdict-btn"][data-verdict="accept"]`);
    await expect(accept).toBeVisible();

    // …expand the inline transcript to grow the evidence well past one screen,
    // then scroll the detail panel to the TOP. The verdict bar must remain within
    // the panel's viewport (sticky), not pushed below the fold.
    await detail.locator(`[data-testid="finding-evidence-turn-toggle"]`).click();
    await detail.evaluate((el) => el.scrollTo(0, 0));

    const acceptBox = await accept.boundingBox();
    const detailBox = await detail.boundingBox();
    expect(acceptBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    // the button's bottom edge sits within the detail panel's box (i.e. visible
    // without scrolling the panel) — the definition of a working sticky bar.
    expect(acceptBox!.y + acceptBox!.height).toBeLessThanOrEqual(
      detailBox!.y + detailBox!.height + 1,
    );
    expect(acceptBox!.y).toBeGreaterThanOrEqual(detailBox!.y - 1);
  });

  // ④ regression for bug D: selecting a 2nd finding must NOT change the layout
  test("selecting the 2nd finding does not shift the list-rail width (bug D)", async ({
    page,
  }) => {
    await page.goto(`/?session=${FINDING_FIXTURE.sessionId}&tab=findings`);
    const rows = page.locator(`[data-testid="finding-row"]`);
    await expect(rows.nth(1)).toBeVisible();

    const railWidth = () =>
      page.locator(`[data-testid="findings-list"]`).evaluate((el) => el.getBoundingClientRect().width);

    await rows.nth(0).click();
    const before = await railWidth();
    await rows.nth(1).click();
    const after = await railWidth();
    // the list rail is a fixed track — its width is identical regardless of which
    // finding (and however tall its detail) is selected.
    expect(Math.abs(after - before)).toBeLessThanOrEqual(0.5);

    // and selection is client-side: the URL gains ?finding=<id> via replaceState
    // (no full navigation), so the detail swaps instantly.
    await expect(page).toHaveURL(/finding=/);
  });

  // ④b regression for the Findings left-blank / horizontal-shift bug: on the
  // cross-session AXIS, selecting EACH finding in turn must keep the master-detail
  // grid pinned to the same left edge AND must never make the page scroll
  // horizontally — including the finding whose evidence is a long no-wrap command.
  // A long one-liner is absorbed by per-pane horizontal scroll (design rule: 無言
  // の切り捨て禁止 / ページ幅オーバーフロー構造防止), not by widening the grid.
  test("selecting any finding keeps the grid left edge fixed and never scrolls the page (left-blank bug)", async ({
    page,
  }) => {
    await page.goto("/findings");
    await page.locator(`[data-testid="findings-filter"] button`, { hasText: "All" }).click();
    const rows = page.locator(`[data-testid="finding-row"]`);
    const count = await rows.count();
    expect(count).toBeGreaterThan(1);

    const gridLeft = () =>
      page.locator(`[data-testid="findings-md-grid"]`).evaluate((el) => el.getBoundingClientRect().left);
    const pageOverflow = () =>
      page.evaluate(() => {
        const se = document.scrollingElement!;
        return se.scrollWidth - se.clientWidth;
      });

    let firstLeft: number | null = null;
    for (let i = 0; i < count; i++) {
      await rows.nth(i).click();
      await expect(page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`)).toBeVisible();
      const left = await gridLeft();
      if (firstLeft === null) firstLeft = left;
      // the grid's left edge is identical for every selection (no rightward shift,
      // no left blank gap opening up).
      expect(Math.abs(left - firstLeft)).toBeLessThanOrEqual(1);
      // and the page itself never gains a horizontal scrollbar.
      expect(await pageOverflow()).toBeLessThanOrEqual(1);
    }
  });

  // ④c the long no-wrap command is absorbed by per-pane horizontal scroll: the
  // excerpt pane scrolls (scrollWidth > clientWidth) but the page does not, and
  // the line is NOT wrapped (white-space:pre) — visible, not silently truncated.
  test("a long no-wrap command scrolls inside its excerpt pane, not the page", async ({
    page,
  }) => {
    await page.goto("/findings");
    await page.locator(`[data-testid="findings-filter"] button`, { hasText: "All" }).click();
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.longLine }).click();
    const detail = page.locator(`[data-testid="finding-detail"][data-detail-finding-id]`);
    await expect(detail).toBeVisible();
    const pre = detail.locator(`[data-testid="finding-excerpt-pre"]`).first();
    await expect(pre).toBeVisible();

    const m = await pre.evaluate((el) => {
      const se = document.scrollingElement!;
      const cs = getComputedStyle(el);
      return {
        whiteSpace: cs.whiteSpace,
        overflowX: cs.overflowX,
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
        pageScrollW: se.scrollWidth,
        pageClientW: se.clientWidth,
      };
    });
    // the one-liner is NOT wrapped…
    expect(m.whiteSpace).toBe("pre");
    // …it scrolls horizontally inside its own pane…
    expect(m.overflowX).toBe("auto");
    expect(m.scrollW).toBeGreaterThan(m.clientW);
    // …and that scroll never escapes to widen the page.
    expect(m.pageScrollW).toBeLessThanOrEqual(m.pageClientW + 1);
  });

  // ⑥ evidence group header carries BOTH always-visible actions (requirement C):
  // VIEW TURN and VIEW SESSION, each with a destination-describing title — no
  // need to expand the inline transcript to find a way into the session.
  test("evidence group header always shows VIEW TURN and VIEW SESSION actions", async ({
    page,
  }) => {
    await page.goto("/findings");
    await page.locator(`[data-testid="findings-filter"] button`, { hasText: "All" }).click();
    await page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.turnSeq }).click();
    const card = page
      .locator(`[data-testid="finding-detail"][data-detail-finding-id]`)
      .locator('[data-testid="finding-evidence-card"][data-evidence-kind="turn"]');
    const viewTurn = card.locator(`[data-testid="finding-evidence-action-turn"]`);
    const viewSession = card.locator(`[data-testid="finding-evidence-action-session"]`);
    // both are visible WITHOUT expanding the inline transcript.
    await expect(viewTurn).toBeVisible();
    await expect(viewTurn).toHaveText(/VIEW TURN/);
    await expect(viewTurn).toHaveAttribute("title", /Open the transcript at this turn/);
    await expect(viewSession).toBeVisible();
    await expect(viewSession).toHaveText(/VIEW SESSION/);
    await expect(viewSession).toHaveAttribute("title", /Open the full session transcript/);
  });

  // ⑦ deep-link landing (requirement D): clicking VIEW TURN from the cross-session
  // axis deep-links into the owning session, where a dismissible banner names the
  // step and the originating finding, and the landed step is flashed.
  test("VIEW TURN deep-links into the session with a dismissible landing banner", async ({
    page,
  }) => {
    await page.goto("/findings");
    await page.locator(`[data-testid="findings-filter"] button`, { hasText: "All" }).click();
    const findingRow = page.locator(`[data-testid="finding-row"]`, { hasText: FINDING_FIXTURE.titles.turnSeq });
    await findingRow.click();
    const findingId = await findingRow.getAttribute("data-finding-id");
    expect(findingId).toBeTruthy();

    const card = page
      .locator(`[data-testid="finding-detail"][data-detail-finding-id]`)
      .locator('[data-testid="finding-evidence-card"][data-evidence-kind="turn"]');
    await card.locator(`[data-testid="finding-evidence-action-turn"]`).click();

    // landed on the owning session's transcript, carrying the originating finding.
    await expect(page).toHaveURL(new RegExp(`session=${FINDING_FIXTURE.sessionId}`));
    await expect(page).toHaveURL(new RegExp(`fromFinding=${findingId}`));

    // the landing banner names the finding and is dismissible…
    const banner = page.locator(`[data-testid="jump-landing-banner"]`);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(`from finding #${findingId}`);

    // …and the landed step is flashed/selected (highlight, requirement D).
    const head = page.locator(`[data-testid="event-row"][data-eid="${FINDING_FIXTURE.sessionId}-event-1"]`);
    await expect(head).toHaveAttribute("data-selected", "true");

    await banner.locator(`[data-testid="jump-landing-dismiss"]`).click();
    await expect(banner).toHaveCount(0);
  });
});
