import type { KnipConfig } from "knip";

const config: KnipConfig = {
  compilers: { mdx: true },
  ignore: [
    "packages/docnode-editor/src/**",
    "docs/source.config.ts",
    "docs/src/components/ui/**",
  ],
  // TODO: maybe I should ignore specifically for each package instead of the whole monorepo
  // Dependencies that are used in the package.json scripts
  ignoreDependencies: [
    "bun",
    "lint-staged",
    "mitata",
    "concurrently",
    "postcss",
    // Required by ESLint for TypeScript-config syntax highlighting in Node.
    "shiki",
  ],
  ignoreBinaries: ["lsof"], // used in the package.json scripts
  workspaces: {
    examples: {
      entry: [
        "collab-server/docsync-server.ts",
        "collab-server/drizzle.config.ts",
      ],
    },
  },
};

export default config;
