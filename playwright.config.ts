import { defineConfig, devices } from "@playwright/test";

const baseURLExamples =
  process.env.VERCEL_URL != null
    ? `https://${process.env.VERCEL_URL}/`
    : `http://localhost:${process.env.PORT ?? 4000}/`;
const baseURLDocs =
  process.env.VERCEL_URL != null
    ? `https://${process.env.VERCEL_URL}/`
    : "http://localhost:3000/";

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
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3000",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
  // prettier-ignore
  projects: [
    { name: "chromium", testIgnore: ["**/tests/docs/**"], use: { ...devices["Desktop Chrome"] } },
    { name: "chromium-docs", testMatch: ["**/tests/docs/**/*.ui*.ts"], use: { ...devices["Desktop Chrome"], baseURL: baseURLDocs } },
  ],
});
