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
          include: ["**/*.browser.test.ts", "**/*.browser.test.tsx"],
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
    ],
  },
});
