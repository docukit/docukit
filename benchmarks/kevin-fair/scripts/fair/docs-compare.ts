// Statistics of the app-shaped documents probe: same rule as the Kevin rows (stats.ts: mean, % against the better Yjs,
// pooled paired-block interval, +-2 % band, A/B drift check, flags). A run still busy after its retries gets
// "no verdict: busy machine".
// usage: node docs-compare.ts <dir with docs-A.json docs-B.json docs-ic-A.json docs-ic-B.json>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  judge,
  roundMap,
  allValues,
  spread,
  mean,
  type Runs,
} from "./stats.ts";
const DIR = process.argv[2]!;
const load = (f: string) =>
  existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
const COLS = [
  { key: "save", label: "save (toJSON + stringify)", unit: "ms" },
  { key: "load", label: "load (parse + fromJSON)", unit: "ms" },
  { key: "toJSON", label: "toJSON", unit: "ms" },
  { key: "fromJSON", label: "fromJSON", unit: "ms" },
  { key: "gzip", label: "gzip", unit: "B" },
  { key: "raw", label: "raw", unit: "B" },
  { key: "memWarm", label: "memory (2nd load)", unit: "B" },
  { key: "memFair", label: "memory (1st load)", unit: "B" },
];
const summarize = (
  a: any,
  b: any,
  yjs: string[],
  cols: { key: string; unit: string }[],
  suffix = "",
) => {
  const cells: any = {};
  const busy = !!(a.meta?.repeat || b.meta?.repeat);
  for (const kind of Object.keys(a.timing))
    for (const col of cols) {
      const get = (run: any, lib: string) =>
        roundMap(run.timing[kind]?.[lib]?.samples, (raw) =>
          typeof raw[col.key + suffix] === "number"
            ? raw[col.key + suffix]
            : undefined,
        );
      const libs = Object.keys(a.timing[kind]);
      const all: Record<string, Runs> = Object.fromEntries(
        libs.map((l) => [l, { A: get(a, l), B: get(b, l) }]),
      );
      const ys = yjs.filter((y) => all[y] && allValues(all[y]!).length);
      const refs = Object.fromEntries(ys.map((y) => [y, all[y]!]));
      for (const lib of libs) {
        const p = allValues(all[lib]!);
        if (!p.length) continue;
        const extra = {
          min: Math.min(...p),
          max: Math.max(...p),
          spread: spread(p),
        };
        const j = judge(all[lib]!, ys.includes(lib) ? {} : refs, {
          tiny: col.unit === "ms",
          busy,
        });
        if (ys.includes(lib)) {
          // A Yjs row: its mean only; the better Yjs is marked as the reference.
          const best = ys.reduce((x, y) =>
            mean(allValues(all[y]!)) < mean(allValues(all[x]!)) ? y : x,
          );
          j.outcome = lib === best ? "reference" : "other Yjs";
        }
        ((cells[kind] ??= {})[col.key] ??= {})[lib] = { ...j, ...extra };
      }
    }
  return cells;
};
const [A, B] = [load(`${DIR}/docs-A.json`), load(`${DIR}/docs-B.json`)];
const out: any = {
  cols: COLS,
  cells: summarize(A, B, ["yjs13", "yjs14"], COLS),
  meta: { A: A.meta, B: B.meta },
};
// Yjs has no toJSON / fromJSON: those columns exist only for DocNode (no reference, no %).
const [IA, IB] = [load(`${DIR}/docs-ic-A.json`), load(`${DIR}/docs-ic-B.json`)];
if (IA && IB) {
  out.ic = {
    cells: summarize(
      IA,
      IB,
      [],
      [
        { key: "load", unit: "i" },
        { key: "save", unit: "i" },
        { key: "parse", unit: "i" },
        { key: "fromJSON", unit: "i" },
        { key: "toJSON", unit: "i" },
        { key: "stringify", unit: "i" },
      ],
      "Ins",
    ),
    meta: { A: IA.meta, B: IB.meta },
  };
}
writeFileSync(`${DIR}/fair-docs-summary.json`, JSON.stringify(out, null, 1));
console.log("docs summary written");
