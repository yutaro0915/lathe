import { type Page } from "@playwright/test";

// Drive the TopBar project-scope control in e2e. It is a CUSTOM lathe dropdown
// now (a trigger button + a styled menu), NOT a native <select>, so the old
// `page.locator('[data-testid="project-picker"]').selectOption(value)` no longer
// works. These helpers open the trigger (testid `project-picker`) and click the
// option whose `data-project` matches the value (testid `project-option`),
// preserving the prior contract: picking a project writes ?project= and the
// synthetic `all` row resets the scope.

// Open the dropdown and pick the option whose value (data-project) matches.
export async function pickProject(page: Page, value: string): Promise<void> {
  await page.locator(`[data-testid="project-picker"]`).click();
  await page.locator(`[data-testid="project-option"][data-project="${value}"]`).click();
}

// Read the selectable project values from the dropdown (every option's
// `data-project` except the synthetic `all` row). Replaces the old
// `picker.locator("option")…` read against a native <select>. Leaves the menu
// closed so it does not intercept later clicks.
export async function projectOptionValues(page: Page): Promise<string[]> {
  const trigger = page.locator(`[data-testid="project-picker"]`);
  await trigger.click();
  const values = await page
    .locator(`[data-testid="project-option"]`)
    .evaluateAll((els) =>
      (els as HTMLElement[])
        .map((e) => e.getAttribute("data-project") ?? "")
        .filter((v) => v && v !== "all"),
    );
  await trigger.click();
  return values;
}
