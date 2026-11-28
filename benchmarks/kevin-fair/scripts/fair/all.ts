// The whole fair measurement, one process at a time: runs A and B (Kevin rows + G1.8 and G1.9), the GC diagnostics
// pass, the bytes pass, the instruction pass, then the statistics. Repeats a run when the machine was busy (exit code
// 3 of run.ts); a run still busy after the last try keeps `meta.repeat`, and its cells get "no verdict: busy machine".
// usage: SUBJECTS=yjs13,yjs14,<base>,<new> BASE=<base> NEW=<new> node scripts/fair/all.ts [steps]
//   steps = comma list of: runs,gc,extra,ic,compare (default: all of these), and the optional confirmation steps:
//     confirm: a separate 60 + 60 round run (same protocol, same rows) for the cells named in CONFIRM, for example
//              CONFIRM="B1.11:save,G1.9:time" (columns: loadNoGc, time, save). Decides those cells on its own with
//              97.5 % intervals; the report shows both.
//     heap2:   runs A and B again (30 + 30) with a predefined second heap history: heap-preload.ts allocates 16 MB of
//              short-lived objects at process start. The report shows both histories and the cross-history outcome.
//   Run `compare` again after `confirm` or `heap2`.
// env: W (work folder, default: benchmarks/kevin-fair), OUT_DIR (default: $W/out/fair), SUBJECTS (required: the Yjs
//      names plus bundle names in $W/bundles), BASE and NEW (the two DocNode bundles of the instruction pass),
//      ROUNDS (30), GC_ROUNDS (30), EXTRA_ROUNDS (5), IC_ROUNDS (15), CONFIRM_ROUNDS (60), CONFIRM,
//      TEXT_SUBJECTS (the Yjs names plus the bundles that have `text()`): adds the text set (B1.1-B1.7, B2.1-B2.4,
//      B3.5, B4). A separate set because every subject of a process must run the same rows: they share one seeded
//      random generator, and the harness stops at the first row a subject cannot run.
// Writes the wall time of every step to $OUT_DIR/wall.json (docs-all.ts adds "docs"; report.ts prints the total).
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { phase } from "./wall.ts";
const W =
  process.env.W ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIR = process.env.OUT_DIR ?? `${W}/out/fair`;
const steps = (process.argv[2] ?? "runs,gc,extra,ic,compare").split(",");
const SUBJECTS = process.env.SUBJECTS;
if (!SUBJECTS)
  throw new Error("set SUBJECTS, e.g. SUBJECTS=yjs13,yjs14,base,new");
// G1.8 and G1.9 = B1.8 and B1.9 with Yjs storing one element per number (XmlElement in Yjs 13, Node in Yjs 14).
const G_SUBJECTS =
  process.env.G_SUBJECTS ??
  SUBJECTS.replace("yjs13", "yjs13xml").replace("yjs14", "yjs14node");
const KEVIN_ROWS = "[B1.8],[B1.9],[B1.10],[B1.11],[B3.1],[B3.2],[B3.3],[B3.4]";
const TEXT_ROWS =
  "[B4],[B1.1],[B1.2],[B1.3],[B1.4],[B1.5],[B1.6],[B1.7],[B2.1],[B2.2],[B2.3],[B2.4],[B3.5]";
const TEXT_SUBJECTS = process.env.TEXT_SUBJECTS;
const ROUNDS = process.env.ROUNDS ?? "30",
  GC_ROUNDS = process.env.GC_ROUNDS ?? "30",
  EXTRA_ROUNDS = process.env.EXTRA_ROUNDS ?? "5",
  IC_ROUNDS = process.env.IC_ROUNDS ?? "15",
  CONFIRM_ROUNDS = process.env.CONFIRM_ROUNDS ?? "60";
const IC_SUBJECTS =
  process.env.IC_SUBJECTS ??
  (process.env.BASE && process.env.NEW
    ? `${process.env.BASE},${process.env.NEW}`
    : "");
mkdirSync(DIR, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const run = (out: string, env: Record<string, string>, maxTries = 3) => {
  for (let i = 1; i <= maxTries; i++) {
    log("start", out, i > 1 ? `(try ${i})` : "");
    const r = spawnSync(process.execPath, [`${W}/scripts/fair/run.ts`], {
      env: { ...process.env, W, OUT: out, ...env },
      stdio: "inherit",
    });
    if (r.status === 0) return;
    if (r.status !== 3)
      throw new Error(`run.ts failed (${r.status}) for ${out}`);
    if (i === maxTries) {
      // Never used for a verdict: compare.ts reads `meta.repeat` and marks the cells "no verdict: busy machine".
      log(
        "WARNING: still busy after",
        maxTries,
        "tries; its cells get no verdict (busy machine):",
        out,
      );
      return;
    }
    log("busy machine: repeating", out);
  }
};
const sets = [
  { id: "kevin", subjects: SUBJECTS, rows: KEVIN_ROWS },
  { id: "g", subjects: G_SUBJECTS, rows: "[B1.8],[B1.9]" },
  ...(TEXT_SUBJECTS
    ? [{ id: "text", subjects: TEXT_SUBJECTS, rows: TEXT_ROWS }]
    : []),
];
const PRELOAD = `--import ${W}/scripts/fair/heap-preload.ts`;
const withPreload = process.env.EXTRA_FLAGS
  ? `${process.env.EXTRA_FLAGS} ${PRELOAD}`
  : PRELOAD;
// Named cells of the confirmation run, e.g. "B1.11:save" (set kevin) or "G1.9:time" (set g).
const CONFIRM = (process.env.CONFIRM ?? "").split(",").filter(Boolean);
const setOf = (cell: string) =>
  cell.startsWith("G")
    ? "g"
    : TEXT_ROWS.includes(`[${cell.slice(0, cell.indexOf(":"))}]`)
      ? "text"
      : "kevin";

if (steps.includes("runs"))
  phase(DIR, "official runs", () => {
    for (const ab of ["A", "B"])
      for (const s of sets)
        run(`${DIR}/${s.id}-${ab}.json`, {
          SUBJECTS: s.subjects,
          ROWS: s.rows,
          ROUNDS,
          MODE: "time",
          LABEL: `${s.id} run ${ab}`,
        });
  });
if (steps.includes("gc"))
  // GC diagnostics: a separate pass with FAIR_GC=1, same rows and subjects. Never decides an outcome.
  phase(DIR, "GC diagnostics", () => {
    for (const s of sets)
      run(`${DIR}/${s.id}-gc.json`, {
        SUBJECTS: s.subjects,
        ROWS: s.rows,
        ROUNDS: GC_ROUNDS,
        MODE: "time",
        FAIR_GC: "1",
        LABEL: `${s.id} GC diagnostics`,
      });
  });
if (steps.includes("extra"))
  phase(DIR, "bytes", () => {
    for (const ab of ["A", "B"])
      for (const s of sets)
        run(`${DIR}/${s.id}-x${ab}.json`, {
          SUBJECTS: s.subjects,
          ROWS: s.rows,
          ROUNDS: EXTRA_ROUNDS,
          MODE: "extra",
          LABEL: `${s.id} bytes ${ab}`,
        });
  });
if (steps.includes("ic")) {
  // Instructions: DocNode against DocNode only (BASE vs NEW), B1 rows. Never used against Yjs.
  if (!IC_SUBJECTS)
    log("skipping the instruction pass: set BASE and NEW (or IC_SUBJECTS)");
  else
    phase(DIR, "instructions", () => {
      for (const ab of ["A", "B"])
        run(`${DIR}/ic-${ab}.json`, {
          SUBJECTS: IC_SUBJECTS,
          ROWS: "[B1.8],[B1.9],[B1.10],[B1.11]",
          ROUNDS: IC_ROUNDS,
          MODE: "time",
          FAIR_IC: "1",
          LABEL: `instructions ${ab}`,
        });
    });
}
if (steps.includes("confirm")) {
  if (!CONFIRM.length)
    throw new Error('set CONFIRM, e.g. CONFIRM="B1.11:save,G1.9:time"');
  writeFileSync(
    `${DIR}/confirm.json`,
    JSON.stringify({ cells: CONFIRM, rounds: Number(CONFIRM_ROUNDS) }),
  );
  phase(DIR, "confirmation", () => {
    for (const ab of ["A", "B"])
      for (const s of sets.filter((x) =>
        CONFIRM.some((c) => setOf(c) === x.id),
      ))
        run(`${DIR}/confirm-${s.id}-${ab}.json`, {
          SUBJECTS: s.subjects,
          ROWS: s.rows,
          ROUNDS: CONFIRM_ROUNDS,
          MODE: "time",
          LABEL: `${s.id} confirmation ${ab}`,
        });
  });
}
if (steps.includes("heap2"))
  phase(DIR, "second heap history", () => {
    for (const ab of ["A", "B"])
      for (const s of sets)
        run(`${DIR}/h2-${s.id}-${ab}.json`, {
          SUBJECTS: s.subjects,
          ROWS: s.rows,
          ROUNDS,
          MODE: "time",
          EXTRA_FLAGS: withPreload,
          LABEL: `${s.id} second heap history ${ab}`,
        });
  });
if (steps.includes("compare"))
  phase(DIR, "statistics", () => {
    const files = (id: string) => ({
      A: `${DIR}/${id}-A.json`,
      B: `${DIR}/${id}-B.json`,
      xA: `${DIR}/${id}-xA.json`,
      xB: `${DIR}/${id}-xB.json`,
      gc: `${DIR}/${id}-gc.json`,
      h2A: `${DIR}/h2-${id}-A.json`,
      h2B: `${DIR}/h2-${id}-B.json`,
      cA: `${DIR}/confirm-${id}-A.json`,
      cB: `${DIR}/confirm-${id}-B.json`,
    });
    const cfg = {
      confirm: `${DIR}/confirm.json`,
      sets: [
        { id: "kevin", ...files("kevin"), yjs: ["yjs13", "yjs14"] },
        {
          id: "g",
          ...files("g"),
          yjs: ["yjs13xml", "yjs14node"],
          rename: {
            "[B1.8] Append N numbers":
              "[G1.8] Append N numbers (Yjs: XmlElement / Node)",
            "[B1.9] Insert Array of N numbers":
              "[G1.9] Insert Array of N numbers (Yjs: XmlElement / Node)",
          },
        },
        ...(TEXT_SUBJECTS
          ? [{ id: "text", ...files("text"), yjs: ["yjs13", "yjs14"] }]
          : []),
      ],
    };
    writeFileSync(`${DIR}/config.json`, JSON.stringify(cfg, null, 1));
    const r = spawnSync(
      process.execPath,
      [
        `${W}/scripts/fair/compare.ts`,
        `${DIR}/config.json`,
        `${DIR}/fair-summary.json`,
      ],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw new Error("compare failed");
  });
