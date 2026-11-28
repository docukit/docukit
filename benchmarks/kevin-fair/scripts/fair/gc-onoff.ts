// One-time check (README rule 13): does FAIR_GC=1 (the GC observer and allocation counters of the diagnostics pass)
// change the timed windows? Same protocol as run.ts: one fresh process per round and setting, all rows in it, the
// two settings alternate their order every round, one process at a time. Compares the means of FAIR_GC=1 against
// FAIR_GC=0 with the method's statistics (one run, so no A/B drift check).
// usage: node scripts/fair/gc-onoff.ts <subject> [out.json]
// env: W (work folder), ROWS (default "[B1.8],[B1.9],[B1.10],[B1.11]"), ROUNDS (30)
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, roundMap, num, type Runs } from "./stats.ts";
const W =
  process.env.W ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
const subject = process.argv[2];
if (!subject)
  throw new Error("usage: node scripts/fair/gc-onoff.ts <subject> [out.json]");
const OUT = process.argv[3] ?? `${W}/out/gc-onoff.json`;
const ROWS = process.env.ROWS ?? "[B1.8],[B1.9],[B1.10],[B1.11]";
const ROUNDS = Number(process.env.ROUNDS ?? 30);
mkdirSync(`${W}/tmp`, { recursive: true });
const tmp = `${W}/tmp/gc-onoff-${process.pid}.json`;
const SETTINGS = ["off", "on"];
const acc: any = {
  meta: {
    subject,
    rows: ROWS.split(","),
    rounds: ROUNDS,
    node: process.version,
    started: new Date().toISOString(),
    loads: [],
  },
  timing: {},
};
for (let r = 0; r < ROUNDS; r++) {
  for (const s of r % 2 ? [...SETTINGS].reverse() : SETTINGS) {
    writeFileSync(tmp, "{}");
    const l0 = loadavg()[0];
    spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--max-old-space-size=2048",
        `${W}/scripts/fair/child.ts`,
        "time",
        subject,
        ROWS,
        tmp,
      ],
      {
        env: { ...process.env, W, FAIR_GC: s === "on" ? "1" : "0" },
        stdio: "ignore",
        timeout: 900_000,
      },
    );
    const res = JSON.parse(readFileSync(tmp, "utf8"));
    acc.meta.loads.push({ round: r, s, load1min: l0, status: res.status });
    if (res.status !== "ok") {
      console.error(s, res.message);
      continue;
    }
    const rows = new Set(
      Object.keys(res.results)
        .filter((k) => k.endsWith("(time)"))
        .map((k) => k.slice(0, k.lastIndexOf(" ("))),
    );
    for (const row of rows)
      ((acc.timing[row] ??= {})[s] ??= { samples: [] }).samples.push({
        round: r,
        load1min: l0,
        raw: res.results,
      });
  }
}
const ls: number[] = acc.meta.loads.map((l: any) => l.load1min);
acc.meta.ended = new Date().toISOString();
acc.meta.fractionAbove6 = ls.filter((x) => x > 6).length / ls.length;
const busy = acc.meta.fractionAbove6 > 0.25;
const result: any = {};
console.log(
  `\nFAIR_GC=1 against FAIR_GC=0, ${subject}, ${ROUNDS} rounds each${busy ? " (BUSY MACHINE: no verdict)" : ""}\n`,
);
console.log(
  "| Row | Window | Mean off | Mean on | % [95 % interval] | Outcome |",
);
console.log("|---|---|---|---|---|---|");
for (const row of Object.keys(acc.timing))
  for (const [col, key] of [
    ["loadNoGc", "loadNoGc exact"],
    ["time", "time exact"],
    ["save", "encodeTime exact"],
  ]) {
    const series = (s: string): Runs => ({
      A: roundMap(acc.timing[row][s]?.samples, (raw) =>
        raw[`${row} (${key})`] === undefined
          ? undefined
          : num(raw[`${row} (${key})`]),
      ),
      B: new Map(),
    });
    const j = judge(series("on"), { off: series("off") }, { tiny: true, busy });
    (result[row] ??= {})[col] = j;
    console.log(
      `| ${row.slice(0, row.indexOf("]") + 1)} | ${col} | ${j.refMean?.toFixed(3)} ms | ${j.mean.toFixed(3)} ms | ${j.pct?.toFixed(1)} % [${j.ci?.map((x) => x.toFixed(1)).join(", ")}] | ${j.outcome}${j.flags.length ? ` (${j.flags.join(", ")})` : ""} |`,
    );
  }
acc.result = result;
writeFileSync(OUT, JSON.stringify(acc));
console.log("\nwritten:", OUT);
