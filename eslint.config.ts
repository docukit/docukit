import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";
import playwright from "eslint-plugin-playwright";
import type { ESLint } from "eslint";
import * as regexpPlugin from "eslint-plugin-regexp";
// eslint-plugin-barrel-files has no type declarations
// @ts-expect-error -- untyped package
import barrelFiles from "eslint-plugin-barrel-files";
// eslint-plugin-ts-inline-parameter-types: prefer inline types when used once in params
// @ts-expect-error -- untyped package
import tsInlineParameterTypes from "eslint-plugin-ts-inline-parameter-types";
import eslintPluginImport from "eslint-plugin-import";
import nextVitals from "eslint-config-next/core-web-vitals";

// import eslintPluginUnicorn from "eslint-plugin-unicorn";

// import perfectionist from 'eslint-plugin-perfectionist'
// import { configs as regexpPluginConfigs } from 'eslint-plugin-regexp'
// import eslintConfigPrettier from 'eslint-config-prettier'

export const rootEslintConfig = tseslint.config(
  {
    extends: [
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    rules: {
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "memberLike",
          modifiers: ["private"],
          format: null,
          leadingUnderscore: "require",
        },
        // If it is not private, it should not start with underscore
        // not worthy for the readability: https://github.com/typescript-eslint/typescript-eslint/issues/2240
        // {
        //   selector: "memberLike",
        //   format: null,
        //   leadingUnderscore: "forbid"
        // }
      ],
      // better than disabling it completely, because a property can
      // become public and I might forget to switch to dot notation
      "@typescript-eslint/dot-notation": [
        "error",
        {
          allowPrivateClassPropertyAccess: true,
          allowProtectedClassPropertyAccess: true,
        },
      ],
      "@typescript-eslint/no-this-alias": "off",
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowTernary: true, allowShortCircuit: true },
      ],
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/consistent-indexed-object-style": "off",
      "@typescript-eslint/consistent-type-imports": [
        "warn",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
          },
        },
      ],
      // TODO: enable
      // "@typescript-eslint/no-shadow": "error",
      // "@typescript-eslint/no-redeclare": "error",
      "ts-inline-parameter-types/prefer-inline-type-parameters": "error",
    },
    plugins: {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- untyped plugin
      "ts-inline-parameter-types": tsInlineParameterTypes,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    plugins: {
      vitest,
    },
    rules: {
      "vitest/prefer-strict-equal": "error",
    },
    settings: {
      vitest: {
        typecheck: true,
      },
    },
  },
  {
    plugins: {
      import: eslintPluginImport,
    },
    rules: {
      // Prevent imports that escape package boundaries
      "import/no-relative-packages": "error",
      // Prevent circular dependencies
      "import/no-cycle": ["error", { maxDepth: 5 }],
      // Prevent a module from importing itself
      "import/no-self-import": "error",
      // Ensure all imports are declared in package.json
      "import/no-extraneous-dependencies": [
        "error",
        {
          // prevent importing devDependencies except
          // in paths listed here
          devDependencies: [
            "**/*.test.ts",
            "**/*.test.tsx",
            "**/*.browser.test.ts",
            "**/*.browser.test.tsx",
            "**/*.ui.test.ts",
            "**/tests/**",
            "**/vitest.config.ts",
            "**/playwright.config.ts",
            "**/eslint.config.ts",
            "**/turbo.json",
            "**/next.config.mjs",
            "**/next.config.ts",
            "**/drizzle.config.ts",
            "**/*.config.ts",
            "**/benchmarks/**",
          ],
        },
      ],
      // Prevent duplicate imports from the same module
      "import/no-duplicates": "error",
      // Ensure imports come before other statements
      "import/first": "error",
      // Enforce a newline after import statements
      "import/newline-after-import": "error",
      // TODO: import/no-unused-modules doesn't work with flat config yet
      // See: https://github.com/import-js/eslint-plugin-import/issues/3079
    },
  },
  {
    plugins: {
      playwright,
    },
    rules: {
      // I probably need to tune the additional options
      "playwright/no-get-by-title": "error",
      "playwright/no-duplicate-hooks": "error",
      "playwright/no-element-handle": "error",
      "playwright/no-nth-methods": "error",
      "playwright/missing-playwright-await": "error",
      "playwright/no-page-pause": "error",
      "playwright/no-useless-await": "error",
      "playwright/no-useless-not": "error",
      "playwright/no-wait-for-selector": "error",
      "playwright/no-wait-for-timeout": "error",
      "playwright/prefer-locator": "error",
      "playwright/prefer-strict-equal": "error",
      "playwright/prefer-to-be": "error",
      "playwright/prefer-to-contain": "error",
      "playwright/prefer-to-have-count": "error",
      "playwright/prefer-to-have-length": "error",
      "playwright/prefer-web-first-assertions": "error",
      "playwright/require-hook": "error",
      "playwright/require-to-throw-message": "error",
      "playwright/valid-expect-in-promise": "error",
      "playwright/valid-expect": "error",
    },
    files: ["**/*.ui.test.ts"],
  },
  {
    plugins: {
      regexp: regexpPlugin,
    },
    rules: regexpPlugin.configs["flat/recommended"].rules,
  },
  // Barrel files (re-exports) allowed only in **/exports/**; override below turns rule off there
  {
    files: ["packages/**"],
    plugins: { "barrel-files": barrelFiles as ESLint.Plugin },
    rules: {
      "barrel-files/avoid-barrel-files": [
        "error",
        { amountOfExportsToConsiderModuleAsBarrel: 0 },
      ],
    },
  },
  {
    files: ["packages/**/exports/**"],
    rules: {
      "barrel-files/avoid-barrel-files": "off",
    },
  },

  {
    rules: {
      "@typescript-eslint/no-restricted-types": [
        "error",
        {
          types: {
            null: {
              message:
                "Using 'null' as a type is not allowed. Use 'undefined' instead.",
              fixWith: "undefined",
            },
          },
        },
      ],
    },
    ignores: ["**/*.test.ts"],
  },
  ...nextVitals.map((config) => ({
    ...config,
    files: ["**/*.{jsx,tsx}"],
  })),
  {
    files: ["**/*.{jsx,tsx}"],
    settings: {
      next: {
        rootDir: ["docs/", "examples/"],
      },
    },
    rules: {
      "react/no-unescaped-entities": "off",
    },
  },
  {
    ignores: [
      "**/dist",
      "**/.next",
      "**/node_modules",
      "**/.test-results",
      "**/.source",
      "**/next-env.d.ts",
    ],
  },
);

export default rootEslintConfig;
