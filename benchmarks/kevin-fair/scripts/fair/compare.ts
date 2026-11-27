// Statistics of the Kevin rows: reads the config written by all.ts and writes the summary JSON.
// usage: node compare.ts <config.json> <summary.json>
// config: { sets: [{ id, A, B, xA, xB, yjs: [names of the two Yjs of that set], rename?: {rowTitle: newTitle} }] }
// For every library x row x column: median (all rounds of A and B together), min/max, % vs the Yjs (13 or 14) with the
// lowest median over all the rounds of that cell, bootstrap interval, verdict of A, of B and the final verdict.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { compareCell, med, spread, num, type Cell } from "./stats.ts";

type Col = {
  key: string;
  label: string;
  unit: "ms" | "B";
  src: "run" | "extra";
  get: (raw: Record<string, unknown>, row: string) => number | undefined;
};
const rawGet =
  (suffix: string) => (raw: Record<string, unknown>, row: string) => {
    const v = raw[`${row} (${suffix})`];
    return v === undefined ? undefined : num(v);
  };
const COLS: Col[] = [
  {
    key: "bytes",
    label: "bytes/update (gzip of the stream)",
    unit: "B",
    src: "extra",
    get: (r) => r.streamGzip as number | undefined,
  },
  {
    key: "doc",
    label: "stored doc (gzip)",
    unit: "B",
    src: "extra",
    get: (r) => r.docGzip as number | undefined,
  },
  {
    key: "loadNoGc",
    label: "load without forced GC",
    unit: "ms",
    src: "run",
    get: rawGet("loadNoGc exact"),
  },
  {
    key: "loadKevin",
    label: "load, Kevin (parseTime)",
    unit: "ms",
    src: "run",
    get: rawGet("parseTime exact"),
  },
  {
    key: "mem",
    label: "memory (memFairWarm)",
    unit: "B",
    src: "run",
    get: rawGet("memFairWarm"),
  },
  {
    key: "time",
    label: "time",
    unit: "ms",
    src: "run",
    get: rawGet("time exact"),
  },
  {
    key: "save",
    label: "save",
    unit: "ms",
    src: "run",
    get: rawGet("encodeTime exact"),
  },
  // Kept in the raw data and in the summary, not in the main tables.
  {
    key: "memFair",
    label: "memFair (1st load)",
    unit: "B",
    src: "run",
    get: rawGet("memFair"),
  },
  {
    key: "memUsed",
    label: "memUsed (upstream)",
    unit: "B",
    src: "run",
    get: rawGet("memUsed"),
  },
  {
    key: "avgUpdate",
    label: "avgUpdateSize / updateSize (raw)",
    unit: "B",
    src: "run",
    get: (raw, row) => {
      const v = raw[`${row} (avgUpdateSize)`] ?? raw[`${row} (updateSize)`];
      return v === undefined ? undefined : num(v);
    },
  },
  {
    key: "docRaw",
    label: "docSize (raw)",
    unit: "B",
    src: "run",
    get: rawGet("docSize"),
  },
];

const cfg = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const out: any = {
  method: "fair",
  cols: COLS.map(({ key, label, unit }) => ({ key, label, unit })),
  sets: {},
  cells: {},
  meta: { runs: {} },
};
const load = (f: string | undefined) =>
  f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;

for (const set of cfg.sets) {
  const [A, B, xA, xB] = [load(set.A), load(set.B), load(set.xA), load(set.xB)];
  out.meta.runs[set.id] = Object.fromEntries(
    Object.entries({ A, B, xA, xB })
      .filter(([, v]) => v)
      .map(([k, v]: [string, any]) => [
        k,
        {
          node: v.meta.node,
          rounds: v.meta.rounds,
          started: v.meta.started,
          ended: v.meta.ended,
          loadSummary: v.meta.loadSummary,
          repeat: v.meta.repeat,
        },
      ]),
  );
  const rows = Object.keys(A.timing);
  const libs = Object.keys(A.timing[rows[0]!]);
  out.sets[set.id] = {
    yjs: set.yjs,
    libs,
    rows: rows.map((r) => set.rename?.[r] ?? r),
  };
  for (const row of rows) {
    const title = set.rename?.[row] ?? row;
    for (const col of COLS) {
      const src = (run: any, lib: string) => {
        const r = col.src === "extra" ? run.x : run.t;
        // The bytes pass runs one row per process and keys the rows by their prefix, e.g. "[B1.8]".
        const key =
          col.src === "extra" ? row.slice(0, row.indexOf("]") + 1) : row;
        const samples = r?.timing?.[key]?.[lib]?.samples ?? [];
        return samples
          .map((s: any) => col.get(s.raw, row))
          .filter(
            (v: unknown): v is number =>
              typeof v === "number" && !Number.isNaN(v),
          );
      };
      const runs = { A: { t: A, x: xA }, B: { t: B, x: xB } };
      const sam = (lib: string) => ({
        A: src(runs.A, lib),
        B: src(runs.B, lib),
      });
      const all = Object.fromEntries(libs.map((l) => [l, sam(l)]));
      const pooled = (l: string) => [...all[l]!.A, ...all[l]!.B];
      // Reference: the Yjs with the lowest median over all the rounds of the cell.
      const yjs = set.yjs.filter((y: string) => pooled(y).length);
      if (!yjs.length) continue;
      const ref = yjs.reduce((a: string, b: string) =>
        med(pooled(b)) < med(pooled(a)) ? b : a,
      );
      for (const lib of libs) {
        const p = pooled(lib);
        if (!p.length) continue;
        const cell: Cell = {
          median: med(p),
          min: Math.min(...p),
          max: Math.max(...p),
          n: p.length,
          spread: spread(p),
          ref,
          refMedian: med(pooled(ref)),
          ...(lib === ref
            ? {
                pct: 0,
                ci: null,
                pctA: null,
                pctB: null,
                ciA: null,
                ciB: null,
                verdictA: null,
                verdictB: null,
                verdict: "reference",
              }
            : compareCell(
                all[lib]!.A,
                all[lib]!.B,
                all[ref]!.A,
                all[ref]!.B,
                col.unit === "ms",
              )),
        };
        ((out.cells[title] ??= {})[col.key] ??= {})[lib] = cell;
      }
    }
  }
}

writeFileSync(process.argv[3]!, JSON.stringify(out, null, 1));
console.log(
  "summary written:",
  process.argv[3],
  Object.keys(out.cells).length,
  "rows",
);
