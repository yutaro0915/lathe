import { defineConfig, devices } from "@playwright/test";

// E2E runs against a production build on a dedicated port (default 3211) so it
// never collides with the dev preview server (3210) or its .next cache.
// Override with E2E_PORT so parallel worktrees don't fight over the same port.
const PORT = Number(process.env.E2E_PORT) || 3211;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      // Wide width (~desktop). Runs the WHOLE suite, including the layout gate.
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1500, height: 1000 } },
    },
    // Second width for the render-integrity gate ONLY (e2e/layout-integrity.spec.ts):
    // narrow surfaces hit breakpoint-specific 段差 / overflow the wide render
    // hides, so the layout gate runs at BOTH widths. The rest of the suite is not
    // written for 700px, so this project is scoped to the layout spec alone (it
    // reads the project's viewport so a violation reports the width it fired at).
    {
      name: "chromium-narrow",
      testMatch: /layout-integrity\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 700, height: 1000 } },
    },
  ],
  webServer: {
    // build + start a production server; assumes Postgres has already been ingested.
    command: `pnpm build && pnpm start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
  },
});
