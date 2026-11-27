// Pilot: warm measurement. One process: run the selected rows WARM times without keeping results, then MEAS times
// keeping the exact time / save / load-without-forced-GC of each row.
// usage: node --expose-gc --max-old-space-size=2048 warm-pilot.ts <subject> <rows> <out.json>
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const W =
  process.env.W ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [subject, rowsArg, out] = process.argv.slice(2) as [
  string,
  string,
  string,
];
const WARM = Number(process.env.WARM ?? 10),
  MEAS = Number(process.env.MEAS ?? 10);
const prefixes = rowsArg.split(",");
const wanted = (n: string) => prefixes.some((p) => n.startsWith(p));
const imp = async (p: string) => import(pathToFileURL(`${W}/${p}`).href);
const Factory =
  subject === "yjs13"
    ? (await imp("cb/benchmarks/yjs/factory.js")).YjsFactory
    : subject === "yjs14"
      ? (await imp("cb/benchmarks/yjs14/factory.js")).Yjs14Factory
      : (await imp(`bundles/${subject}.mjs`)).DocNodeFactory;
const factory = new Factory();
const lib = await imp("cb/js-lib-fair/index.js");
const info = console.info,
  log = console.log;
console.info = () => {};
console.log = () => {};
const samples: Record<string, number[]> = {};
const gc = (globalThis as any).gc as () => void;
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  if (process.env.SETTLE) {
    gc();
    gc();
    await new Promise((r) => setTimeout(r, 0));
  }
};
for (let i = 0; i < WARM + MEAS; i++) {
  await settle();
  for (const k of Object.keys(lib.benchmarkResults))
    delete lib.benchmarkResults[k];
  await lib.runBenchmarks(factory, wanted);
  if (i < WARM) continue;
  for (const [k, v] of Object.entries(lib.benchmarkResults)) {
    if (!/\((time|encodeTime|loadNoGc) exact\)$/.test(k)) continue;
    (samples[k] ??= []).push(Object.values(v as object)[0] as number);
  }
}
console.info = info;
console.log = log;
writeFileSync(out, JSON.stringify({ subject, node: process.version, samples }));
