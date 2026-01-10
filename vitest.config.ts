import { defineConfig, type TestProjectConfiguration } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";

// In development: resolve to source files for faster testing without building
// In CI: use dist files to test what actually gets published
// see https://nx.dev/docs/technologies/test-tools/vitest/guides/testing-without-building-dependencies
const resolveConfig = !process.env.CI ? { conditions: ["vitest"] } : {};

const project = (name: string, browser: boolean): TestProjectConfiguration => ({
  extends: true, // Extends root config to include resolve.conditions
  plugins: [react()],
  test: {
    // Needed for server logs (in globalSetup) to be visible in tests
    disableConsoleIntercept: true,
    // Browser tests need more time due to Playwright startup overhead
    // This prevents false failures from browser launch timeouts
    testTimeout: 2000, // (includes Playwright launch time?)
    hookTimeout: 2000,
    ...(browser
      ? {
          include: ["**/*.browser.test.ts", "**/*.browser.test.tsx"],
        }
      : {
          exclude: [
            "**/*.browser.test.ts",
            "**/*.browser.test.tsx",
            "**/*.ui.test.ts",
            "**/node_modules",
            "**/dist",
          ],
        }),
    globalSetup: ["./tests/docsync/int/local-first/globalSetup.ts"],
    benchmark: {
      include: ["**/*browser.bench.ts"],
    },
    name,
    browser: {
      screenshotFailures: false,
      headless: true,
      enabled: browser,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});

export default defineConfig({
  resolve: resolveConfig,
  // SSR mode is used by Vitest for Node environment tests
  ssr: {
    resolve: resolveConfig,
  },
  test: {
    // Global timeouts - prevent tests from hanging indefinitely
    // Node tests should be fast (2s max)
    testTimeout: 2000, // 2 seconds max per test
    hookTimeout: 2000, // 2 seconds max per hook (beforeAll, afterEach, etc)
    coverage: {
      reportsDirectory: ".test-results/vitest",
      reporter: ["text", "html"],
      exclude: [
        "**/node_modules/**",
        "**/tests/**",
        "**/*.d.ts",
        "**/*.test.ts",
        "**/*.spec.ts",
      ],
    },
    projects: [project("node", false), project("browser", true)],
  },
});
