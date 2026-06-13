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
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1500, height: 1000 } },
    },
  ],
  webServer: {
    // build + start a production server; assumes Postgres has already been ingested.
    command: `LATHE_CHAT_PROVIDER=fake pnpm build && LATHE_CHAT_PROVIDER=fake pnpm start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
  },
});
