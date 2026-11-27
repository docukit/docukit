import type { KnipConfig } from "knip";

const config: KnipConfig = {
  compilers: { mdx: true },
  ignore: [
    "packages/docnode-editor/src/**",
    "docs/source.config.ts",
    "docs/src/components/ui/**",
    // Research scripts outside the workspace (see benchmarks/kevin-fair/README.md).
    "benchmarks/kevin-fair/**",
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
  rules: {
    // Optional peer deps (e.g. react in @docukit/docnode-lexical) are
    // legitimately referenced from optional bindings.
    optionalPeerDependencies: "off",
  },
};

export default config;
