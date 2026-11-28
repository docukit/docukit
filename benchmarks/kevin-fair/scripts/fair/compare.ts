// Statistics of the Kevin rows: reads the config written by all.ts and writes the summary JSON.
// usage: node compare.ts <config.json> <summary.json>
// config: { sets: [{ id, A, B, xA, xB, gc?, h2A?, h2B?, cA?, cB?, yjs: [the two Yjs of that set],
//           rename?: {rowTitle: newTitle} }], confirm?: <confirm.json> }
// For every library x row x column: mean and median (all rounds of A and B), min/max, % against the better Yjs (13 or
// 14, the lowest mean), the pooled interval, the outcome and its flags (stats.ts). Timed columns also get the GC
// diagnostics of the separate FAIR_GC=1 pass, and, when those runs exist, the second heap history and the
// confirmation run of the named cells.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  judge,
  roundMap,
  allValues,
  spread,
  num,
  mean,
  crossHistory,
  DECIDED,
  type Runs,
} from "./stats.ts";

type Col = {
  key: string;
  /** The harness window of a timed column (for the GC diagnostics keys). */
  window?: string;
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
    // Uncompressed: DocSync (Socket.IO) sends updates as they are, and gzip on a single small update makes it bigger.
    key: "bytes",
    label: "bytes/update (uncompressed)",
    unit: "B",
    src: "extra",
    get: (r) =>
      typeof r.bytes === "number" && typeof r.updates === "number" && r.updates
        ? r.bytes / r.updates
        : undefined,
  },
  {
    key: "doc",
    label: "stored doc (gzip)",
    unit: "B",
    src: "extra",
    get: (r) => r.docGzip as number | undefined,
  },
  {
    key: "docRaw",
    label: "stored doc (uncompressed)",
    unit: "B",
    src: "extra",
    get: (r) => r.docRaw as number | undefined,
  },
  {
    key: "loadNoGc",
    window: "loadNoGc",
    label: "load without forced GC",
    unit: "ms",
    src: "run",
    get: rawGet("loadNoGc exact"),
  },
  {
    key: "loadKevin",
    window: "parseTime",
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
    window: "time",
    label: "time",
    unit: "ms",
    src: "run",
    get: rawGet("time exact"),
  },
  {
    key: "save",
    window: "encodeTime",
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
];

// A GC pause inside the window in more rounds of one library than of its reference, by more than this many points,
// qualifies the outcome (README rule 13).
const GC_SHARE_POINTS = 20;
// "higher allocation during load" when the load allocates at least this many times the reference's bytes.
const ALLOC_RATIO = 2;
const QUALIFIER =
  "in the fixed benchmark sequence; size sensitive to GC placement";
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
const confirm = load(cfg.confirm);
const confirmCells = new Set<string>(confirm?.cells ?? []);
out.meta.confirm = confirm;

/** GC diagnostics of one library in one window, from the FAIR_GC=1 pass. */
const gcDiag = (run: any, row: string, lib: string, window: string) => {
  const s: any[] = run?.timing?.[row]?.[lib]?.samples ?? [];
  const k = (suffix: string) =>
    s
      .map((x) => x.raw[`${row} (${window} ${suffix})`])
      .filter((v): v is number => typeof v === "number");
  const pause = k("gc"),
    noPause = k("noGcPause"),
    alloc = k("alloc"),
    exact = k("exact");
  if (!pause.length) return undefined;
  const busy = !!run.meta?.repeat;
  const pauseRounds = pause.filter((v) => v > 0).length;
  return {
    n: pause.length,
    pauseRounds,
    pauseShare: pauseRounds / pause.length,
    pauseMean: mean(pause),
    noPauseMean: mean(noPause),
    mean: mean(exact),
    allocMB: mean(alloc) / 1e6,
    busy,
  };
};

for (const set of cfg.sets) {
  const files = {
    A: load(set.A),
    B: load(set.B),
    xA: load(set.xA),
    xB: load(set.xB),
    gc: load(set.gc),
    h2A: load(set.h2A),
    h2B: load(set.h2B),
    cA: load(set.cA),
    cB: load(set.cB),
  };
  out.meta.runs[set.id] = Object.fromEntries(
    Object.entries(files)
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
  const { A, B, xA, xB, gc } = files;
  const rows = Object.keys(A.timing);
  const libs = Object.keys(A.timing[rows[0]!]);
  out.sets[set.id] = {
    yjs: set.yjs,
    libs,
    rows: rows.map((r) => set.rename?.[r] ?? r),
    gcPass: !!gc,
    secondHistory: !!(files.h2A && files.h2B),
  };
  for (const row of rows) {
    const title = set.rename?.[row] ?? row;
    const id = title.slice(1, title.indexOf("]"));
    for (const col of COLS) {
      // The bytes pass runs one row per process and keys the rows by their prefix, e.g. "[B1.8]".
      const key =
        col.src === "extra" ? row.slice(0, row.indexOf("]") + 1) : row;
      const series = (a: any, b: any, lib: string): Runs => ({
        A: roundMap(a?.timing?.[key]?.[lib]?.samples, (raw) =>
          col.get(raw, row),
        ),
        B: roundMap(b?.timing?.[key]?.[lib]?.samples, (raw) =>
          col.get(raw, row),
        ),
      });
      const [a, b] = col.src === "extra" ? [xA, xB] : [A, B];
      const busy = !!(a?.meta?.repeat || b?.meta?.repeat);
      const all = Object.fromEntries(libs.map((l) => [l, series(a, b, l)]));
      const yjs = set.yjs.filter((y: string) => allValues(all[y]!).length);
      if (!yjs.length) continue;
      const refs = (src: Record<string, Runs>) =>
        Object.fromEntries(yjs.map((y: string) => [y, src[y]!]));
      const best = yjs.reduce((x: string, y: string) =>
        mean(allValues(all[y]!)) < mean(allValues(all[x]!)) ? y : x,
      );
      for (const lib of libs) {
        const p = allValues(all[lib]!);
        if (!p.length) continue;
        const isYjs = yjs.includes(lib);
        const j = judge(all[lib]!, isYjs ? { [best]: all[best]! } : refs(all), {
          tiny: col.unit === "ms",
          busy,
        });
        const cell: any = {
          ...j,
          min: Math.min(...p),
          max: Math.max(...p),
          spread: spread(p),
        };
        if (isYjs) {
          cell.outcome = lib === best ? "reference" : "other Yjs";
          cell.flags = [];
        }
        if (col.window && !isYjs) {
          // GC diagnostics: shown, never change the outcome; only qualify it.
          const g = gcDiag(gc, row, lib, col.window),
            gr = gcDiag(gc, row, j.ref ?? best, col.window);
          if (g && gr) {
            cell.gc = g;
            cell.gcRef = gr;
            const points = Math.abs(g.pauseShare - gr.pauseShare) * 100;
            if (points > GC_SHARE_POINTS) {
              cell.gcPlacement = true;
              if (DECIDED.has(cell.outcome)) cell.qualifier = QUALIFIER;
              else cell.flags.push("GC placement differs");
            }
            if (col.key === "loadNoGc" && g.allocMB >= ALLOC_RATIO * gr.allocMB)
              cell.flags.push("higher allocation during load");
          }
        }
        cell.text = cell.qualifier
          ? `${cell.outcome} ${cell.qualifier}`
          : cell.outcome;
        if (col.window && !isYjs) {
          // Second predefined heap history (16 MB of short-lived garbage at process start).
          if (files.h2A && files.h2B) {
            const h = Object.fromEntries(
              libs.map((l) => [l, series(files.h2A, files.h2B, l)]),
            );
            const hBusy = !!(files.h2A.meta.repeat || files.h2B.meta.repeat);
            const j2 = judge(h[lib]!, refs(h), { tiny: true, busy: hBusy });
            cell.h2 = {
              mean: j2.mean,
              ref: j2.ref,
              refMean: j2.refMean,
              pct: j2.pct,
              ci: j2.ci,
              outcome: j2.outcome,
              flags: j2.flags,
            };
            if (j2.pct !== null && j2.pct !== undefined && j.pct !== null)
              cell.cross = crossHistory(cell.outcome, j2.outcome);
          }
          // Confirmation run of a named cell: 60 + 60 rounds, decides on its own, with 97.5 % intervals.
          if (confirmCells.has(`${id}:${col.key}`) && files.cA && files.cB) {
            const c = Object.fromEntries(
              libs.map((l) => [l, series(files.cA, files.cB, l)]),
            );
            const cBusy = !!(files.cA.meta.repeat || files.cB.meta.repeat);
            const j3 = judge(c[lib]!, refs(c), {
              tiny: true,
              busy: cBusy,
              level: 0.975,
            });
            cell.confirm = {
              n: j3.n,
              mean: j3.mean,
              ref: j3.ref,
              refMean: j3.refMean,
              pct: j3.pct,
              ci: j3.ci,
              level: j3.level,
              outcome: j3.outcome,
              flags: j3.flags,
            };
          }
        }
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
