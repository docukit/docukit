// App-shaped documents probe: runs A and B (15 rounds each, one after the other), the instruction pass for BASE and
// NEW, then the statistics (docs-compare.ts). A run still busy after 3 tries keeps `meta.repeat`, and its cells get
// "no verdict: busy machine". Adds the phase "docs" to $OUT_DIR/wall.json.
// usage: SUBJECTS=yjs13,yjs14,<base>,<new> BASE=<base> NEW=<new> node scripts/fair/docs-all.ts
// env: W (work folder, default: benchmarks/kevin-fair), OUT_DIR (default: $W/out/fair), ROUNDS (15). Each DocNode
//      subject is a tree in $W/trees/<name>.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { phase } from "./wall.ts";
const W =
  process.env.W ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DIR = process.env.OUT_DIR ?? `${W}/out/fair`;
if (!process.env.SUBJECTS)
  throw new Error("set SUBJECTS, e.g. SUBJECTS=yjs13,yjs14,base,new");
mkdirSync(DIR, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const run = (out: string, env: Record<string, string>) => {
  for (let i = 1; i <= 3; i++) {
    log("start", out, i > 1 ? `(try ${i})` : "");
    const r = spawnSync(process.execPath, [`${W}/scripts/fair/docs.ts`], {
      env: { ...process.env, W, OUT: out, ...env },
      stdio: "inherit",
    });
    if (r.status === 0) return;
    if (r.status !== 3) throw new Error(`docs.ts failed (${r.status})`);
    if (i === 3)
      log(
        "WARNING: still busy after 3 tries; its cells get no verdict (busy machine):",
        out,
      );
    else log("busy machine: repeating", out);
  }
};
const ROUNDS = process.env.ROUNDS ?? "15";
phase(DIR, "docs", () => {
  for (const ab of ["A", "B"]) run(`${DIR}/docs-${ab}.json`, { ROUNDS });
  if (process.env.BASE && process.env.NEW) {
    for (const ab of ["A", "B"])
      run(`${DIR}/docs-ic-${ab}.json`, {
        ROUNDS,
        FAIR_IC: "1",
        SUBJECTS: `${process.env.BASE},${process.env.NEW}`,
      });
  } else log("skipping the instruction pass: set BASE and NEW");
  const r = spawnSync(
    process.execPath,
    [`${W}/scripts/fair/docs-compare.ts`, DIR],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("docs-compare failed");
});
