import type { KnipConfig } from "knip";

const config: KnipConfig = {
  compilers: { mdx: true },
  ignore: [
    "packages/docnode-editor/src/**",
    "docs/source.config.ts",
    "docs/src/components/ui/**",
    "examples/collab-server/**",
  ],
  // TODO: maybe I should ignore specifically for each package instead of the whole monorepo
  // Dependencies that are used in the package.json scripts
  ignoreDependencies: [
    "bun",
    "lint-staged",
    "mitata",
    "concurrently",
    "postcss",
  ],
  ignoreBinaries: ["lsof"], // used in the package.json scripts
};

export default config;
