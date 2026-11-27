// The one way to tell whether a DocNode change is faster or slower. It runs the whole fair method on two DocuKit
// checkouts (BASE and NEW): runs A and B of 30 rounds, instructions A and B of 15 rounds, and the fixed statistics.
// It prints only verdicts: better / worse / same / inconclusive, with the median % next to "better" or "worse" only.
// A number used for a decision or a PR description comes from here, nowhere else.
//
// usage: node scripts/fair/docnode-compare.ts <base-tree> <new-tree> [--smoke]
//   <tree>: a DocuKit checkout, for example a git worktree in trees/<name>.
//   --smoke: 5 rounds, one run, no instructions. It names the cells that may have changed by more than 15 %, with no
//   numbers, so that nobody reads it as a result: short runs move with GC and JIT timing (rules 5 and 6 in the
//   README). Confirm with a full run.
// env: OUT_DIR (default out/docnode-compare), ROUNDS (30), IC_ROUNDS (15), QUIET_LOAD (4): before each run, wait up to
//   30 minutes for the 1-minute load average to drop under it, so that a busy machine does not burn the run.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { med, num } from "./stats.ts";

const W = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const smoke = args.includes("--smoke");
const [baseTree, newTree] = args.filter((a) => a !== "--smoke");
if (!baseTree || !newTree)
  throw new Error(
    "usage: node scripts/fair/docnode-compare.ts <base-tree> <new-tree> [--smoke]",
  );
const DIR = resolve(process.env.OUT_DIR ?? `${W}/out/docnode-compare`);
const ROUNDS = process.env.ROUNDS ?? "30";
const IC_ROUNDS = process.env.IC_ROUNDS ?? "15";
const QUIET_LOAD = Number(process.env.QUIET_LOAD ?? 4);
const BASE = "dc-base",
  NEW = "dc-new";
const ROWS = "[B1.8],[B1.9],[B1.10],[B1.11],[B3.1],[B3.2],[B3.3],[B3.4]";
// Columns that decide. Kevin's load (`parseTime`) wraps two forced GCs, so it never decides (rule 2).
const COLS = [
  ["time", "time exact"],
  ["save", "encodeTime exact"],
  ["load", "loadNoGc exact"],
] as const;
mkdirSync(DIR, { recursive: true });
mkdirSync(`${W}/bundles`, { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const node = (
  script: string,
  argv: string[],
  env: Record<string, string> = {},
) =>
  spawnSync(process.execPath, [script, ...argv], {
    env: { ...process.env, W, ...env },
    stdio: "inherit",
  }).status;

for (const [name, tree] of [
  [BASE, baseTree],
  [NEW, newTree],
] as const)
  if (
    node(`${W}/scripts/build.ts`, [
      tree,
      `${W}/scripts/docnodeAdapter.ts`,
      `${W}/bundles/${name}.mjs`,
    ]) !== 0
  )
    throw new Error(`could not bundle ${tree}`);

const sleep = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitQuiet = () => {
  const until = Date.now() + 30 * 60_000;
  while (loadavg()[0] > QUIET_LOAD && Date.now() < until) {
    log(`load ${loadavg()[0].toFixed(1)} > ${QUIET_LOAD}: waiting`);
    sleep(30_000);
  }
};
// run.ts exits with 3 when the machine was busy (rule 10): wait and repeat, up to 3 times.
const run = (out: string, env: Record<string, string>) => {
  for (let i = 1; i <= 3; i++) {
    waitQuiet();
    log("start", out, i > 1 ? `(try ${i})` : "");
    const status = node(`${W}/scripts/fair/run.ts`, [], {
      OUT: out,
      SUBJECTS: `${BASE},${NEW}`,
      ROWS,
      ...env,
    });
    if (status === 0) return true;
    if (status !== 3) throw new Error(`run.ts failed (${status}) for ${out}`);
  }
  return false;
};

if (smoke) {
  const out = `${DIR}/smoke.json`;
  run(out, { ROUNDS: "5" });
  const data = JSON.parse(readFileSync(out, "utf8"));
  const values = (row: string, lib: string, key: string) =>
    (data.timing[row]?.[lib]?.samples ?? []).map((s: any) =>
      num(s.raw[`${row} (${key})`]),
    ) as number[];
  const changed: string[] = [];
  for (const row of Object.keys(data.timing))
    for (const [col, key] of COLS) {
      const b = values(row, BASE, key),
        n = values(row, NEW, key);
      if (b.length && n.length && Math.abs(med(n) / med(b) - 1) > 0.15)
        changed.push(`${row.slice(0, row.indexOf("]") + 1)} ${col}`);
    }
  console.log(
    "\nSMOKE (5 rounds, one run): not a result. Cells that may have changed by more than 15 %:",
  );
  console.log(
    changed.length ? changed.map((c) => `  ${c}`).join("\n") : "  none",
  );
  console.log(
    "Confirm with a full run (without --smoke) before reporting or deciding anything.",
  );
  process.exit(0);
}

const ok = [
  run(`${DIR}/kevin-A.json`, { ROUNDS }),
  run(`${DIR}/kevin-B.json`, { ROUNDS }),
  run(`${DIR}/ic-A.json`, { ROUNDS: IC_ROUNDS, FAIR_IC: "1" }),
  run(`${DIR}/ic-B.json`, { ROUNDS: IC_ROUNDS, FAIR_IC: "1" }),
].every(Boolean);
if (node(`${W}/scripts/fair/ic-compare.ts`, [DIR], { BASE, NEW }) !== 0)
  throw new Error("ic-compare failed");
const summary = JSON.parse(readFileSync(`${DIR}/fair-ic-summary.json`, "utf8"));
const pct = (v: number | null | undefined) =>
  v == null ? "" : `${v > 0 ? "+" : ""}${v.toFixed(1)} %`;
console.log(`\nNEW (${newTree}) against BASE (${baseTree})\n`);
console.log("| Row | Column | Verdict | Time | Instructions |");
console.log("|---|---|---|---|---|");
for (const [row, cols] of Object.entries<any>(summary.kevin))
  for (const [col] of COLS) {
    const c = cols[col];
    if (!c) continue;
    const decided = c.judgement === "better" || c.judgement === "worse";
    console.log(
      `| ${row} | ${col} | ${c.judgement} | ${decided ? pct(c.time.pct) : ""} | ${decided ? pct(c.ins.pct) : ""} |`,
    );
  }
if (!ok)
  console.log(
    "\nWARNING: the machine stayed busy (load > 6 in more than a quarter of the processes) in at least one run. Do not use these verdicts; run again on a quiet machine.",
  );
