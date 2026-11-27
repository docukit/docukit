// Bundles the crdt-benchmarks adapter against a prebuilt DocNode library bundle (instead of a source tree).
// usage: node scripts/build-lib.ts <lib.mjs> <out.mjs>
import { build } from "../deps/node_modules/esbuild/lib/main.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const [lib, out] = process.argv.slice(2) as [string, string];
await build({
  entryPoints: [resolve(here, "docnodeAdapter.ts")],
  outfile: out,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  alias: { "@docukit/docnode": resolve(lib) },
  logLevel: "error",
  tsconfigRaw: "{}",
  minify: false,
});
console.log(out);
