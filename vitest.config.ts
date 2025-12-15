import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";

export default defineConfig({
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
        test: {
          // typecheck: {
          //   enabled: true, // I prefer to use tsc for typechecking (pnpm check)
          // },
          setupFiles: ["dotenv/config"],
          exclude: [
            "**/*.browser.test.ts",
            "**/node_modules",
            "**/dist",
            "**/*.e2e*.ts",
          ],
          name: "node",
          environment: "node",
        },
      },
      {
        test: {
          include: ["**/*.browser.test.ts"],
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
