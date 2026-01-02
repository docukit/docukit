import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";
import playwright from "eslint-plugin-playwright";
import * as regexpPlugin from "eslint-plugin-regexp";

// import eslintPluginUnicorn from "eslint-plugin-unicorn";

// import perfectionist from 'eslint-plugin-perfectionist'
// import { configs as regexpPluginConfigs } from 'eslint-plugin-regexp'
// import eslintConfigPrettier from 'eslint-config-prettier'

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { FlatConfig } from "@typescript-eslint/utils/ts-eslint";

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
    files: ["**/*.e2e.test.ts"],
  },
  {
    plugins: {
      regexp: regexpPlugin,
    },
    rules: regexpPlugin.configs["flat/recommended"].rules,
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
