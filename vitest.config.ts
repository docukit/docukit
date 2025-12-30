import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import react from "@vitejs/plugin-react";

// In development: resolve to source files for faster testing without building
// In CI: use dist files to test what actually gets published
// see https://nx.dev/docs/technologies/test-tools/vitest/guides/testing-without-building-dependencies
const resolveConfig = !process.env.CI ? { conditions: ["vitest"] } : {};

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
    projects: [
      {
        extends: true, // Extends root config to include resolve.conditions
        test: {
          // typecheck: {
          //   enabled: true, // I prefer to use tsc for typechecking (pnpm check)
          // },
          setupFiles: ["dotenv/config"],
          exclude: [
            "**/*.browser.test.ts",
            "**/*.browser.test.tsx",
            "**/node_modules",
            "**/dist",
            "**/*.e2e*.ts",
          ],
          name: "node",
          environment: "node",
        },
      },
      {
        extends: true, // Extends root config to include resolve.conditions
        plugins: [react()],
        test: {
          // Browser tests need more time due to Playwright startup overhead
          // This prevents false failures from browser launch timeouts
          testTimeout: 3000, // (includes Playwright launch time?)
          hookTimeout: 10000,
          include: [
            "**/*.browser.test.ts",
            "**/*.browser.test.tsx",
            "!**/integration/**", // Exclude integration tests (they have their own config)
            "!**/local-first/**", // Exclude local-first tests (they have their own project)
          ],
          benchmark: {
            include: ["**/*browser.bench.ts"],
          },
          name: "browser",
          browser: {
            screenshotFailures: false,
            headless: true,
            enabled: true,
            provider: playwright(),
            instances: [
              {
                browser: "chromium",
              },
            ],
          },
        },
      },
      {
        extends: true, // Extends root config to include resolve.conditions
        plugins: [react()],
        test: {
          // Browser tests with Socket.IO need more time for network operations
          testTimeout: 3000, // (includes Playwright launch time?)
          hookTimeout: 10000,
          include: ["**/local-first/**/*.browser.test.ts"],
          name: "local-first",
          globalSetup: ["./tests/docsync/local-first/globalSetup.ts"],
          browser: {
            screenshotFailures: false,
            headless: true,
            enabled: true,
            provider: playwright(),
            instances: [
              {
                browser: "chromium",
              },
            ],
          },
        },
      },
    ],
  },
});
