import { test, expect } from "@playwright/test";

// Assertions are structural (counts change, classes toggle, URL changes) rather
// than tied to specific seeded titles, so they stay green as the ingested
// transcripts grow.

test.describe("Session viewer (/)", () => {
  test("loads with sessions, a named header and a timeline", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".session-item").first()).toBeVisible();
    // refined header: session is named + a compact stat cluster
    await expect(page.locator(".sessbar .sessbar-title")).toBeVisible();
    await expect(page.locator(".sessbar .sessbar-stats")).toContainText("tokens");
    expect(await page.locator(".event-row").count()).toBeGreaterThan(0);
  });

  test("tabs switch the centre content", async ({ page }) => {
    await page.goto("/");
    const tabs = page.locator(".tabs .tab");
    await tabs.filter({ hasText: "Raw JSON" }).click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Raw JSON/);
    await tabs.filter({ hasText: "Subagents" }).click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Subagents/);
    await tabs.filter({ hasText: "Transcript" }).click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
    await expect(page.locator(".event-row").first()).toBeVisible();
  });

  test("event-type filter reduces the timeline", async ({ page }) => {
    await page.goto("/");
    const before = await page.locator(".event-row").count();
    await page.locator(".filters .event-type-badge").first().click();
    await expect
      .poll(async () => page.locator(".event-row").count())
      .toBeLessThan(before);
  });

  test("clicking an event selects it (detail panel)", async ({ page }) => {
    await page.goto("/");
    const rows = page.locator(".event-row");
    const n = await rows.count();
    await rows.nth(Math.min(5, n - 1)).click();
    await expect(page.locator(".event-row.selected")).toHaveCount(1);
  });

  test("session search filters the list and clears", async ({ page }) => {
    await page.goto("/");
    const before = await page.locator(".session-item").count();
    const box = page.getByPlaceholder(/Search sessions/i);
    await box.fill("zzz-no-such-session-zzz");
    await expect(page.locator(".session-item")).toHaveCount(0);
    await box.fill("");
    await expect(page.locator(".session-item")).toHaveCount(before);
  });

  test("switching session navigates with ?session=", async ({ page }) => {
    await page.goto("/");
    await page.locator(".session-item").nth(1).click();
    await expect(page).toHaveURL(/\?session=/);
    await expect(page.locator(".session-item.active")).toHaveCount(1);
  });

  test("Pin persists to localStorage", async ({ page }) => {
    await page.goto("/");
    await page.locator(".event-row").nth(0).click();
    await page.locator(".btn", { hasText: /Pin/i }).first().click();
    const pins = await page.evaluate(() => localStorage.getItem("lathe.pins"));
    expect(pins && pins.length).toBeTruthy();
  });

  test("cost is derived from token usage and shown ($)", async ({ page }) => {
    await page.goto("/");
    // header stat cluster has a Cost figure
    await expect(
      page.locator(".sessbar-stats .kstat", { hasText: "cost" })
    ).toBeVisible();
    // priceable (Opus) sessions show a real dollar amount in the list, not "—"
    const dollarCosts = page.locator(".session-item .chip.cost", { hasText: "$" });
    expect(await dollarCosts.count()).toBeGreaterThan(0);
  });
});

test.describe("Diff viewer (/diff)", () => {
  test("loads with changed files and a diff", async ({ page }) => {
    await page.goto("/diff");
    await expect(page.locator(".file-row").first()).toBeVisible();
    expect(await page.locator(".diff-hunk").count()).toBeGreaterThan(0);
  });

  test("selecting a file updates the diff path", async ({ page }) => {
    await page.goto("/diff");
    const before = await page.locator(".fpath").innerText();
    const files = page.locator(".file-row:not(.is-folder)");
    const count = await files.count();
    for (let i = 0; i < count; i++) {
      const f = files.nth(i);
      const cls = (await f.getAttribute("class")) || "";
      if (!cls.includes("active")) {
        await f.click();
        break;
      }
    }
    await expect(page.locator(".fpath")).not.toHaveText(before);
  });

  test("unified/split toggle changes the diff layout", async ({ page }) => {
    await page.goto("/diff");
    const diff = page.locator(".diff");
    const before = await diff.innerHTML();
    await page.locator(".segmented button", { hasText: "Split" }).click();
    await expect(page.locator(".segmented button.active")).toHaveText(/Split/);
    await expect.poll(async () => diff.innerHTML()).not.toBe(before);
  });

  test("folder twisty collapses its children", async ({ page }) => {
    await page.goto("/diff");
    const folders = page.locator(".file-row.is-folder");
    if ((await folders.count()) > 0) {
      const before = await page.locator(".file-row").count();
      await folders.first().click();
      await expect
        .poll(async () => page.locator(".file-row").count())
        .toBeLessThan(before);
    }
  });

  test("Raw JSON button reveals the event JSON", async ({ page }) => {
    await page.goto("/diff");
    const btn = page.locator(".btn", { hasText: /Raw JSON/i }).first();
    if ((await btn.count()) > 0) {
      const preBefore = await page.locator("pre").count();
      await btn.click();
      await expect.poll(async () => page.locator("pre").count()).toBeGreaterThan(preBefore);
    }
  });

  test("linked events stack (meta below title, no le-right overlap)", async ({ page }) => {
    await page.goto("/diff");
    const le = page.locator(".linked-event").first();
    if ((await le.count()) > 0) {
      await expect(le.locator(".le-turn")).toHaveCount(1);
      await expect(le.locator(".le-meta")).toHaveCount(1);
      // old overlapping layout used .le-right; it must be gone
      await expect(le.locator(".le-right")).toHaveCount(0);
    }
  });

  test("the session list stays on the Git tab (can switch sessions)", async ({ page }) => {
    await page.goto("/diff"); // redirects to /?session=…&tab=git
    // the diff is embedded; the host session list is still in the sidebar
    await expect(page.locator(".diff-embed")).toBeVisible();
    const items = page.locator(".session-list .session-item");
    await expect(items.first()).toBeVisible();
    if ((await items.count()) > 1) {
      await items.nth(1).click();
      await expect(page).toHaveURL(/session=/);
    }
  });
});

test.describe("Cross-screen navigation & time ribbon", () => {
  test("Git is an in-page tab: diff shows, session list stays, no navigation", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".tabs .tab", { hasText: "Git" }).click();
    // does NOT navigate away to /diff…
    await expect(page).not.toHaveURL(/\/diff/);
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Git/);
    // …the diff working area is embedded in place…
    await expect(page.locator(".diff-embed")).toBeVisible();
    // …and the session list sidebar is still there to switch sessions.
    await expect(page.locator(".session-list .session-item").first()).toBeVisible();
  });

  test("from the Git tab, other tabs switch in-page (no /diff page)", async ({ page }) => {
    await page.goto("/diff"); // redirects to /?session=…&tab=git
    await expect(page).not.toHaveURL(/\/diff/);
    await page.locator(".tabs .tab", { hasText: "Transcript" }).click();
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Transcript/);
    await expect(page.locator(".timeline .event-row").first()).toBeVisible();
  });

  test("?tab opens the viewer on that tab", async ({ page }) => {
    await page.goto("/?tab=subagents");
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Subagents/);
  });

  test("time ribbon renders with segments on the session viewer", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".ribbon-track")).toBeVisible();
    expect(await page.locator(".ribbon-seg").count()).toBeGreaterThan(0);
  });

  test("time ribbon zoom widens the track", async ({ page }) => {
    await page.goto("/");
    const track = page.locator(".ribbon-track");
    const w0 = await track.evaluate((el) => el.style.width);
    await page.locator(".ribbon .minimap-zoom button", { hasText: "+" }).click();
    await expect.poll(async () => track.evaluate((el) => el.style.width)).not.toBe(w0);
  });
});

test.describe("Event detail panel", () => {
  test("shows compact stats (duration/exit) and a wrapping output", async ({ page }) => {
    await page.goto("/?session=da2ac032-a905-4267-8e5f-851456926a79");
    const bashRow = page
      .locator(".event-row")
      .filter({ has: page.locator(".event-icon.bash") })
      .first();
    if ((await bashRow.count()) > 0) {
      await bashRow.click();
      await expect(page.locator(".stat-strip .stat").first()).toBeVisible();
      await expect(page.locator(".code-block.output")).toBeVisible();
      const ws = await page
        .locator(".code-block.output")
        .evaluate((el) => getComputedStyle(el).whiteSpace);
      expect(ws).toBe("pre-wrap"); // output wraps, no horizontal cut-off
      // the old tall key/value table is gone
      await expect(page.locator(".detail .kv dt")).toHaveCount(0);
    }
  });
});

test.describe("Thinking", () => {
  test("thinking events are captured and viewable", async ({ page }) => {
    // a session with extended-thinking (non-redacted) blocks
    await page.goto("/?session=b1dcf7bd-a268-4304-bc4a-b45463538aa2");
    const trow = page
      .locator(".event-row")
      .filter({ has: page.locator(".event-icon.thinking") })
      .first();
    if ((await trow.count()) > 0) {
      await trow.click();
      await expect(page.locator(".detail-head .dtitle")).toHaveText(/Thinking/);
      const body = (await page.locator(".code-block.output").innerText()).trim();
      expect(body.length).toBeGreaterThan(0);
    }
  });
});

test.describe("Sub-agent expansion", () => {
  test("sub-agent rows expand to reveal child steps (tools/skills)", async ({ page }) => {
    // a session known to spawn general-purpose sub-agents
    await page.goto("/?session=da2ac032-a905-4267-8e5f-851456926a79");
    const expanders = page.locator(".tw-expand");
    if ((await expanders.count()) > 0) {
      const before = await page.locator(".event-row").count();
      await expanders.first().click();
      await expect
        .poll(async () => page.locator(".event-row.child-row").count())
        .toBeGreaterThan(0);
      expect(await page.locator(".event-row").count()).toBeGreaterThan(before);
      // a child step should be a real tool/message of the sub-agent
      await expect(page.locator(".event-row.child-row").first()).toBeVisible();
    }
  });
});

test.describe("Sub-agent runs (Subagents tab)", () => {
  // session known to spawn 3 distinct general-purpose runs
  const SID = "da2ac032-a905-4267-8e5f-851456926a79";

  test("overview lists one card per distinct run, not one flat list per name", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    // a tab bar with Overview + one tab per run
    await expect(page.locator(".sa-tab").first()).toContainText(/Overview/);
    const runTabs = page.locator(".sa-tab").filter({ hasText: "general-purpose" });
    expect(await runTabs.count()).toBeGreaterThan(1); // distinct runs, not merged
    // overview shows a card per run with a step count
    const cards = page.locator(".sa-card");
    expect(await cards.count()).toBe(await runTabs.count());
    await expect(cards.first().locator(".sa-card-meta")).toContainText(/steps/);
  });

  test("clicking a run opens its detail tab with the internal execution", async ({
    page,
  }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(".sa-card").first().click();
    // detail header + per-run execution rows appear
    await expect(page.locator(".sa-detail-head")).toContainText(/Agent 1 of/);
    await expect
      .poll(async () => page.locator(".sa-detail .event-row.child-row").count())
      .toBeGreaterThan(0);
    // selecting an internal step drives the right detail panel
    await page.locator(".sa-detail .event-row.child-row").first().click();
    await expect(page.locator(".sa-detail .event-row.child-row.selected")).toHaveCount(1);
    await expect(page.locator(".detail .detail-head .dtitle")).toBeVisible();
  });

  test("Prev/Next steps between runs", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    await page.locator(".sa-card").first().click();
    const nextBtn = page.locator(".sa-detail-head button", { hasText: "Next" });
    await nextBtn.click();
    await expect(page.locator(".sa-detail-head")).toContainText(/Agent 2 of/);
  });

  test("a launcher row in the transcript jumps to its run detail", async ({ page }) => {
    await page.goto(`/?session=${SID}`);
    const jump = page.locator(".sa-jump").first();
    if ((await jump.count()) > 0) {
      await jump.click();
      await expect(page.locator(".tabs .tab.active")).toHaveText(/Subagents/);
      await expect(page.locator(".sa-detail-head")).toContainText(/Agent 1 of/);
    }
  });

  test("each run shows which model ran and its cost", async ({ page }) => {
    await page.goto(`/?session=${SID}&tab=subagents`);
    // overview cards carry a model chip + a $ cost
    await expect(page.locator(".sa-card .sa-model").first()).toBeVisible();
    await expect(page.locator(".sa-card .sa-cost").first()).toContainText("$");
    // the detail view exposes Model + Cost stats
    await page.locator(".sa-tab", { hasText: "general-purpose" }).first().click();
    await expect(
      page.locator(".sa-detail-stats .stat", { hasText: "Model" })
    ).toBeVisible();
    await expect(
      page.locator(".sa-detail-stats .stat", { hasText: "Cost" })
    ).toBeVisible();
  });
});

test.describe("Changed-files tree (compact folders)", () => {
  // session with files nested 8+ levels deep down single-child chains
  const SID = "78a6e038-3829-43bb-98c8-404e8afa8ccc";

  test("single-child folder chains collapse; rows ≈ files, not a row per dir level", async ({
    page,
  }) => {
    await page.goto(`/diff?session=${SID}`);
    await expect(page.locator(".filetree-head .sub")).toHaveText(/5 files changed/);
    // exactly the 5 real files appear as file rows...
    await expect(page.locator(".file-row.is-file")).toHaveCount(5);
    // ...and the whole tree stays compact (no per-directory-level explosion)
    expect(await page.locator(".file-row").count()).toBeLessThanOrEqual(10);
    // a deep chain is merged into ONE folder row whose name carries the "/"-joined path
    const merged = page
      .locator(".file-row.is-folder .fname")
      .filter({ hasText: "/" });
    expect(await merged.count()).toBeGreaterThan(0);
  });

  test("files and folders are visually distinct (status chip vs folder icon)", async ({
    page,
  }) => {
    await page.goto(`/diff?session=${SID}`);
    // files carry a colored A/M/D status chip; folders carry a folder icon, no chip
    await expect(page.locator(".file-row.is-file .status-chip").first()).toBeVisible();
    expect(await page.locator(".file-row.is-folder .ficon.folder svg").count()).toBeGreaterThan(0);
    expect(await page.locator(".file-row.is-folder .status-chip").count()).toBe(0);
  });
});

test.describe("Time ribbon & annotations", () => {
  test("ribbon: hovering reads out the exact time + step", async ({ page }) => {
    await page.goto("/");
    const track = page.locator(".ribbon-track");
    await expect(track).toBeVisible();
    const box = await track.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
      await expect(page.locator(".ribbon-read")).toContainText(/\d{2}:\d{2}:\d{2}/);
    }
  });

  test("ribbon: clicking the track selects the step at the cursor", async ({ page }) => {
    await page.goto("/");
    const track = page.locator(".ribbon-track");
    const box = await track.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
      await expect(page.locator(".event-row.selected")).toHaveCount(1);
    }
  });

  test("ribbon: zooming in adds more time-axis ticks", async ({ page }) => {
    await page.goto("/");
    const before = await page.locator(".ribbon-axis .tick").count();
    await page.locator(".minimap-zoom button", { hasText: "+" }).click();
    await page.locator(".minimap-zoom button", { hasText: "+" }).click();
    await expect
      .poll(async () => page.locator(".ribbon-axis .tick").count())
      .toBeGreaterThan(before);
  });

  test("annotations are labelled (kind + step) and jump on click", async ({ page }) => {
    // a session with errors + commits flagged
    await page.goto("/?session=4912b75c-6018-427c-b67b-00a583404d21");
    const ann = page.locator(".annotation").first();
    if ((await ann.count()) > 0) {
      await expect(ann.locator(".akind-tag")).toBeVisible();
      await expect(ann.locator(".aseq")).toContainText(/step/);
      await ann.click();
      await expect(page.locator(".event-row.selected")).toHaveCount(1);
    }
  });
});

test.describe("Stats (/stats)", () => {
  test("per-project table + usage cards render; a project drills into its sessions", async ({
    page,
  }) => {
    await page.goto("/stats");
    await expect(page.locator(".sessbar-title")).toHaveText(/Statistics/);
    await expect(page.locator(".st-head").first()).toContainText("Cost");
    const rows = page.locator(".st-data");
    expect(await rows.count()).toBeGreaterThan(1);
    // usage observation: models / sub-agent types / skills cards
    expect(await page.locator(".usage-card").count()).toBe(3);
    await expect(page.locator(".usage-card .uh").first()).toContainText("Models");
    // drilling into a project reveals its sessions, each linking to the viewer
    await rows.first().click();
    const sref = page.locator(".st-children .st-srow").first();
    await expect(sref).toBeVisible();
    await expect(sref).toHaveAttribute("href", /\/\?session=/);
  });

  test("the header 統計 link opens /stats", async ({ page }) => {
    await page.goto("/");
    await page.locator(".appnav a", { hasText: "統計" }).click();
    await expect(page).toHaveURL(/\/stats/);
    await expect(page.locator(".sessbar-title")).toHaveText(/Statistics/);
  });

  test("stats keeps the session-list sidebar (same shell, not a separate screen)", async ({
    page,
  }) => {
    await page.goto("/stats");
    await expect(page.locator(".layout3 .sidebar .session-item").first()).toBeVisible();
    // clicking a session in the sidebar goes to the viewer
    await page.locator(".layout3 .sidebar .session-item").first().click();
    await expect(page).toHaveURL(/\?session=/);
  });

  test("by-file table drills a file into the sessions that touched it", async ({ page }) => {
    await page.goto("/stats");
    const fileRow = page.locator(".files-table .st-data").first();
    await expect(fileRow).toBeVisible();
    await fileRow.click();
    const sref = page.locator(".files-table .st-children .st-srow").first();
    await expect(sref).toBeVisible();
    await expect(sref).toHaveAttribute("href", /\/\?session=/);
  });
});
