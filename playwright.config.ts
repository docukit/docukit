import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  testMatch: "tests/**/*.ui*.ts",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI
    ? "github"
    : [["html", { outputFolder: ".test-results/playwright/report" }]],
  outputDir: ".test-results/playwright/test-results",
  retries: 1,
  use: {
    baseURL: process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}/subdocs`
      : `http://localhost:${process.env.PORT ?? 4000}/subdocs`,
    trace: "on",
    video: "retain-on-failure",
    colorScheme: "dark",
  },
  webServer: {
    command: "cd examples && pnpm dev",
    url: "http://localhost:4000",
    reuseExistingServer: !process.env.CI,
  },
  // prettier-ignore
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "Mobile Chrome", use: { ...devices["Pixel 5"] } },
    { name: "Mobile Safari", use: { ...devices["iPhone 12"] } },
  ],
});
