// The whole fair measurement, one process at a time: runs A and B (Kevin rows + G1.8 and G1.9), the bytes pass, the
// instruction pass, then the statistics. Repeats a run when the machine was busy (exit code 3 of run.ts).
// usage: SUBJECTS=yjs13,yjs14,<base>,<new> BASE=<base> NEW=<new> node scripts/fair/all.ts [steps]
//   steps = comma list of: runs,extra,ic,compare (default: all)
// env: W (work folder, default: benchmarks/kevin-fair), OUT_DIR (default: $W/out/fair), SUBJECTS (required: the Yjs
//      names plus bundle names in $W/bundles), BASE and NEW (the two DocNode bundles of the instruction pass),
//      ROUNDS (30), EXTRA_ROUNDS (5), IC_ROUNDS (15)
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const W =
  process.env.W ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIR = process.env.OUT_DIR ?? `${W}/out/fair`;
const steps = (process.argv[2] ?? "runs,extra,ic,compare").split(",");
const SUBJECTS = process.env.SUBJECTS;
if (!SUBJECTS)
  throw new Error("set SUBJECTS, e.g. SUBJECTS=yjs13,yjs14,base,new");
// G1.8 and G1.9 = B1.8 and B1.9 with Yjs storing one element per number (XmlElement in Yjs 13, Node in Yjs 14).
const G_SUBJECTS =
  process.env.G_SUBJECTS ??
  SUBJECTS.replace("yjs13", "yjs13xml").replace("yjs14", "yjs14node");
const KEVIN_ROWS = "[B1.8],[B1.9],[B1.10],[B1.11],[B3.1],[B3.2],[B3.3],[B3.4]";
const ROUNDS = process.env.ROUNDS ?? "30",
  EXTRA_ROUNDS = process.env.EXTRA_ROUNDS ?? "5",
  IC_ROUNDS = process.env.IC_ROUNDS ?? "15";
const IC_SUBJECTS =
  process.env.IC_SUBJECTS ??
  (process.env.BASE && process.env.NEW
    ? `${process.env.BASE},${process.env.NEW}`
    : "");
mkdirSync(DIR, { recursive: true });
const t0 = Date.now();
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
      log(
        "WARNING: still busy after",
        maxTries,
        "tries; keeping the last run:",
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
];
if (steps.includes("runs")) {
  for (const ab of ["A", "B"])
    for (const s of sets)
      run(`${DIR}/${s.id}-${ab}.json`, {
        SUBJECTS: s.subjects,
        ROWS: s.rows,
        ROUNDS,
        MODE: "time",
        LABEL: `${s.id} run ${ab}`,
      });
}
if (steps.includes("extra")) {
  for (const ab of ["A", "B"])
    for (const s of sets)
      run(`${DIR}/${s.id}-x${ab}.json`, {
        SUBJECTS: s.subjects,
        ROWS: s.rows,
        ROUNDS: EXTRA_ROUNDS,
        MODE: "extra",
        LABEL: `${s.id} bytes ${ab}`,
      });
}
if (steps.includes("ic")) {
  // Instructions: DocNode against DocNode only (BASE vs NEW), B1 rows. Never used against Yjs.
  if (!IC_SUBJECTS)
    log("skipping the instruction pass: set BASE and NEW (or IC_SUBJECTS)");
  else
    for (const ab of ["A", "B"])
      run(`${DIR}/ic-${ab}.json`, {
        SUBJECTS: IC_SUBJECTS,
        ROWS: "[B1.8],[B1.9],[B1.10],[B1.11]",
        ROUNDS: IC_ROUNDS,
        MODE: "time",
        FAIR_IC: "1",
        LABEL: `instructions ${ab}`,
      });
}
if (steps.includes("compare")) {
  const cfg = {
    sets: [
      {
        id: "kevin",
        A: `${DIR}/kevin-A.json`,
        B: `${DIR}/kevin-B.json`,
        xA: `${DIR}/kevin-xA.json`,
        xB: `${DIR}/kevin-xB.json`,
        yjs: ["yjs13", "yjs14"],
      },
      {
        id: "g",
        A: `${DIR}/g-A.json`,
        B: `${DIR}/g-B.json`,
        xA: `${DIR}/g-xA.json`,
        xB: `${DIR}/g-xB.json`,
        yjs: ["yjs13xml", "yjs14node"],
        rename: {
          "[B1.8] Append N numbers":
            "[G1.8] Append N numbers (Yjs: XmlElement / Node)",
          "[B1.9] Insert Array of N numbers":
            "[G1.9] Insert Array of N numbers (Yjs: XmlElement / Node)",
        },
      },
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
}
log("wall time of this script:", ((Date.now() - t0) / 60000).toFixed(1), "min");
writeFileSync(
  `${DIR}/wall-${steps.join("-")}.json`,
  JSON.stringify({
    steps,
    minutes: (Date.now() - t0) / 60000,
    started: new Date(t0).toISOString(),
    ended: new Date().toISOString(),
  }),
);
