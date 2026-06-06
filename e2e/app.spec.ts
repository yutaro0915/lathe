import { test, expect } from "@playwright/test";

// Assertions are structural (counts change, classes toggle, URL changes) rather
// than tied to specific seeded titles, so they stay green as the ingested
// transcripts grow.

test.describe("Session viewer (/)", () => {
  test("loads with sessions, metrics and a timeline", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".session-item").first()).toBeVisible();
    await expect(page.locator(".metrics")).toContainText("Branch");
    await expect(page.locator(".metrics")).toContainText("Tokens");
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

  test("session dropdown switches the session", async ({ page }) => {
    await page.goto("/diff");
    const sel = page.locator("select");
    const cur = await sel.inputValue();
    // pick an option that is NOT the current one (selecting the current value
    // would not fire onChange).
    const values = await sel.locator("option").evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value),
    );
    const target = values.find((v) => v && v !== cur);
    if (target) {
      await sel.selectOption(target);
      await expect(page).toHaveURL(new RegExp(`session=${target}`));
    }
  });
});

test.describe("Cross-screen navigation & time ribbon", () => {
  test("viewer Git tab navigates to /diff", async ({ page }) => {
    await page.goto("/");
    await page.locator(".tabs .tab", { hasText: "Git" }).click();
    await expect(page).toHaveURL(/\/diff/);
  });

  test("diff non-Git tab navigates back to the viewer", async ({ page }) => {
    await page.goto("/diff");
    await page.locator(".tabs .tab", { hasText: "Transcript" }).click();
    await expect(page).toHaveURL(/\/\?session=/);
    await expect(page).not.toHaveURL(/\/diff/);
  });

  test("?tab opens the viewer on that tab", async ({ page }) => {
    await page.goto("/?tab=subagents");
    await expect(page.locator(".tabs .tab.active")).toHaveText(/Subagents/);
  });

  test("time ribbon renders on both screens with segments", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".ribbon-track")).toBeVisible();
    expect(await page.locator(".ribbon-seg").count()).toBeGreaterThan(0);
    await page.goto("/diff");
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
