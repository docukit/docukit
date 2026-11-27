// Statistics of the app-shaped documents probe: same rule as the Kevin rows (median, % vs the best Yjs, 95 % bootstrap interval,
// +-2 % band, A and B must agree). usage: node docs-compare.ts <dir with docs-A.json docs-B.json docs-ic-A.json docs-ic-B.json>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { compareCell, med, spread } from "./stats.ts";
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
  for (const kind of Object.keys(a.timing))
    for (const col of cols) {
      const get = (run: any, lib: string) =>
        (run.timing[kind]?.[lib]?.samples ?? [])
          .map((s: any) => s.raw[col.key + suffix])
          .filter((v: unknown): v is number => typeof v === "number");
      const libs = Object.keys(a.timing[kind]);
      const all = Object.fromEntries(
        libs.map((l) => [l, { A: get(a, l), B: get(b, l) }]),
      );
      const pooled = (l: string) => [...all[l]!.A, ...all[l]!.B];
      const ys = yjs.filter((y) => pooled(y).length);
      const ref = ys.length
        ? ys.reduce((x, y) => (med(pooled(y)) < med(pooled(x)) ? y : x))
        : undefined;
      for (const lib of libs) {
        const p = pooled(lib);
        if (!p.length) continue;
        const base = {
          median: med(p),
          min: Math.min(...p),
          max: Math.max(...p),
          n: p.length,
          spread: spread(p),
        };
        ((cells[kind] ??= {})[col.key] ??= {})[lib] = !ref
          ? { ...base, verdict: "no %" }
          : lib === ref
            ? { ...base, ref, pct: 0, verdict: "reference" }
            : {
                ...base,
                ref,
                refMedian: med(pooled(ref)),
                ...compareCell(
                  all[lib]!.A,
                  all[lib]!.B,
                  all[ref]!.A,
                  all[ref]!.B,
                  col.unit === "ms",
                ),
              };
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
