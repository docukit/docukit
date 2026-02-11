import type { KnipConfig } from "knip";

const config: KnipConfig = {
  compilers: {
    mdx: true,
  },
  ignore: [
    "packages/docsync/src/server/providers/postgres/drizzle.config.ts",
    "packages/docsync/src/server/cli.ts",
    "packages/docnode-editor/src/**",
    "docs/source.config.ts",
    "docs/src/components/ui/**",
    "examples/docsync-server.ts",
  ],
  // TODO: maybe I should ignore specifically for each package instead of the whole monorepo
  // Dependencies that are used in the package.json scripts
  ignoreDependencies: [
    "bun",
    "lint-staged",
    "mitata",
    "concurrently",
    "drizzle-kit",
    "postcss",
  ],
  ignoreBinaries: ["lsof"], // used in the package.json scripts
};

export default config;
