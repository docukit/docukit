// Builds the app-shaped documents probe (docs-entry.ts) against one DocNode tree, with the same esbuild options as
// scripts/build.ts.
// usage: node build-docs.ts <tree> <out.mjs>
import { build } from "../../deps/node_modules/esbuild/lib/main.js";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const [tree, out] = process.argv.slice(2) as [string, string];
await build({
  entryPoints: [resolve(here, "docs-entry.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  alias: {
    "@docukit/docnode": join(tree, "packages/docnode/src/exports/index.ts"),
  },
  nodePaths: [resolve(here, "../../deps/node_modules")],
  tsconfigRaw: "{}",
  logLevel: "error",
});
console.log(out);
