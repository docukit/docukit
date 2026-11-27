// Bundles one DocNode tree with an entry (usually the crdt-benchmarks adapter) into a single ESM file.
// usage: node scripts/build.ts <tree> <entry> <out.mjs>
//   <tree>: a DocuKit checkout (for example a git worktree in trees/<name>); "@docukit/docnode" resolves to its
//   packages/docnode/src/exports/index.ts, so no build of the tree is needed.
import { build } from "../deps/node_modules/esbuild/lib/main.js";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const [tree, entry, out] = process.argv.slice(2) as [string, string, string];
await build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  alias: {
    "@docukit/docnode": join(
      resolve(tree),
      "packages/docnode/src/exports/index.ts",
    ),
  },
  nodePaths: [resolve(here, "../deps/node_modules")],
  logLevel: "error",
  tsconfigRaw: "{}",
  minify: false,
});
console.log(out);
