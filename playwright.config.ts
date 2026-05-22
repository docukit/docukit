import { defineConfig, devices } from "@playwright/test";

const baseURLExamples =
  process.env.VERCEL_URL != null
    ? `https://${process.env.VERCEL_URL}/`
    : `http://localhost:${process.env.PORT ?? 3000}/`;
const baseURLDocs =
  process.env.VERCEL_URL != null
    ? `https://${process.env.VERCEL_URL}/`
    : "http://localhost:3000/";
const docsCommand = process.env.CI
  ? "pnpm --filter @docukit/docs start"
  : "pnpm --filter @docukit/docs dev";
const docSyncHealthURL = new URL(
  "/socket.io/socket.io.js",
  process.env.NEXT_PUBLIC_DOCSYNC_SERVER_URL ?? "ws://localhost:8081",
);
if (docSyncHealthURL.protocol === "ws:") {
  docSyncHealthURL.protocol = "http:";
} else if (docSyncHealthURL.protocol === "wss:") {
  docSyncHealthURL.protocol = "https:";
}

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  testMatch: "tests/**/*.ui*.ts",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? "github"
    : [["html", { outputFolder: ".test-results/playwright/report" }]],
  outputDir: ".test-results/playwright/test-results",
  timeout: process.env.CI ? 30_000 : 20_000,
  retries: 1,
  use: {
    baseURL: baseURLExamples,
    trace: "on",
    video: "retain-on-failure",
    colorScheme: "dark",
  },
  webServer: [
    {
      command: docsCommand,
      url: "http://localhost:3000",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm --filter @docukit/docs docsync-server",
      url: docSyncHealthURL.toString(),
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
  // prettier-ignore
  projects: [
    { name: "chromium", testIgnore: ["**/tests/docs/**"], use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-docs", testMatch: ["**/tests/docs/**/*.ui*.ts"], use: { ...devices["Desktop Chrome"], baseURL: baseURLDocs } },
  ],
});
