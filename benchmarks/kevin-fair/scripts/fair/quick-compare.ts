// Quick mode: the default way to check a DocNode change (a few minutes). The full method (docnode-compare.ts, ~25-60
// min) is for important changes, when asked, and to close a milestone.
//
// What it does differently from the full method, and why it stays honest:
//  - Rows: only the rows the change can move, picked from the files it changes (ROW_MAP below). `--rows` overrides.
//  - No waiting for a quiet machine and no repeated runs: every round runs BASE and NEW one after the other (run.ts
//    alternates their order), and the verdict uses each round's pair, so load that hits both cancels out. The load is
//    recorded and shown.
//  - Stops when it knows: it looks at 10, 20 and 40 rounds. A cell is decided when its interval is wholly beyond
//    -2 % / +2 % (better / worse) or wholly inside +-2 % (same). Rows whose cells are all decided leave the next rounds.
//    The first two looks use 99 % intervals and the last one 95 %, so that looking three times does not make a wrong
//    verdict much more likely than one look at 95 %. A cell still undecided says how far its interval reaches: "no
//    change beyond +-X %" is often all a quick check needs.
//  - The same two warm-up passes as the full method. One pass was tried and left code unoptimized (2026-11-28, same
//    tree: B1.9 save +129 %, B1.8 time +15 % against two passes), which changes what is measured.
//  - Statistic: the mean of ln(NEW / BASE) over two-round blocks (a block holds both orders), with a Student t
//    interval. With few blocks the interval is wide, so only clear changes decide early.
//  - Instructions: after the time rounds, 10 paired rounds count the thread's instructions (FAIR_IC=1). They do not
//    move with the machine's load, so their interval is narrow where time's is not. The verdict is "better" / "worse" /
//    "same" only when time and instructions agree, as in the full method; otherwise both readings are shown.
//  - No bytes: they are exact, measure them once with the extra pass.
//
// usage: node scripts/fair/quick-compare.ts <base> <new> [--rows "[B1.8],[B3.1]"]
//   <base>, <new>: a git ref of the DocuKit repository (a branch, a tag, a commit) or a DocuKit checkout directory.
// env: OUT_DIR (default out/quick-compare/<date>), FAIR_WARM (2).
// Writes OUT_DIR/quick-summary.json and adds every cell to out/measured.json (date, commit, mode, rounds, interval,
// spread, load), which the artifact's "updated" column reads.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { med } from "./stats.ts";
import {
  W,
  bundle,
  changedFiles,
  log,
  outcomeOf,
  paired,
  runRounds as runPaired,
  treeOf,
  valuesOf,
  TINY_MS,
  type Store,
} from "./quick.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args.splice(at, 2)[1];
};
const rowsFlag = flag("--rows");
const [baseArg, newArg] = args;
if (!baseArg || !newArg)
  throw new Error(
    'usage: node scripts/fair/quick-compare.ts <base> <new> [--rows "[B1.8],[B3.1]"]',
  );

/** The rows of the fair harness that DocNode runs, by kind. */
const TREE_ROWS = [
  "[B1.8]",
  "[B1.9]",
  "[B1.10]",
  "[B1.11]",
  "[B3.1]",
  "[B3.2]",
  "[B3.3]",
  "[B3.4]",
];
const TEXT_ROWS = [
  "[B1.1]",
  "[B1.2]",
  "[B1.3]",
  "[B1.4]",
  "[B1.5]",
  "[B1.6]",
  "[B1.7]",
];
/**
 * Which rows a changed file of packages/docnode/src can move. A file that is not listed moves every row. Text rows
 * run only where the adapter finds the tree's text (otherwise the child reports "not supported" and they are skipped).
 */
const ROW_MAP: [RegExp, string[]][] = [
  [/\/text\.ts$/, TEXT_ROWS],
  [/\/exports\/compat\.ts$/, []],
  [/\/types\.ts$/, []],
];
/** Column, its time key and its instruction key. */
const COLS = [
  ["time", "time exact", "time ins"],
  ["save", "encodeTime exact", "encodeTime ins"],
  ["loadNoGc", "loadNoGc exact", "loadNoGc ins"],
] as const;
/** Rounds of the instruction pass. */
const IC_ROUNDS = 10;
/** Cumulative rounds of each look, and the interval level used there. */
const LOOKS = [
  { rounds: 10, level: 0.99 },
  { rounds: 20, level: 0.99 },
  { rounds: 40, level: 0.95 },
];
const base = treeOf(baseArg);
const next = treeOf(newArg);
const changed = changedFiles(base, next);
let rows: string[];
if (rowsFlag) rows = rowsFlag.split(",");
else {
  const picked = new Set<string>();
  for (const file of changed) {
    const hit = ROW_MAP.find(([re]) => re.test(file));
    for (const row of hit ? hit[1] : TREE_ROWS) picked.add(row);
  }
  rows = [...TREE_ROWS, ...TEXT_ROWS].filter((r) => picked.has(r));
}
log(
  `changed: ${changed.length ? changed.join(", ") : "nothing in packages/docnode/src"}`,
);
if (rows.length === 0) {
  console.log("\nNo row can move: nothing to measure.");
  process.exit(0);
}
log(`rows: ${rows.join(",")}`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const DIR = resolve(process.env.OUT_DIR ?? `${W}/out/quick-compare/${stamp}`);
mkdirSync(DIR, { recursive: true });
const BASE = "qc-base",
  NEW = "qc-new";
bundle(BASE, base);
bundle(NEW, next);

const samples: Store = new Map();
/** The same for the instruction pass. */
const icSamples: Store = new Map();
const loads: number[] = [];
let done = 0;
let active = [...rows];
type Cell = {
  verdict: string;
  pct: number;
  ci: [number, number];
  level: number;
  rounds: number;
  baseMs: number;
  newMs: number;
  spread: number;
  maxLoad: number;
};
const cells: Record<string, Record<string, Cell>> = {};
const icCells: Record<string, Record<string, Cell>> = {};

/**
 * The cell of one row and column from the samples so far. `tiny`: time, where two means under 0.1 ms give no
 * outcome; instruction counts have no such floor.
 */
function judgeCell(
  store: Store,
  row: string,
  key: string,
  level: number,
  tiny: boolean,
): Cell | undefined {
  const p = paired(
    valuesOf(store, row, NEW, key),
    valuesOf(store, row, BASE, key),
    level,
  );
  if (!p) return undefined;
  const roundLoads = (store.get(row)?.get(NEW) ?? []).map((s) => s.load1min);
  return {
    verdict:
      tiny && p.refMean < TINY_MS && p.libMean < TINY_MS
        ? "no outcome (both < 0.1 ms)"
        : outcomeOf(p.ci),
    pct: p.pct,
    ci: p.ci,
    level,
    rounds: p.rounds,
    baseMs: p.refMean,
    newMs: p.libMean,
    spread: p.spread,
    maxLoad: Math.max(...roundLoads),
  };
}
const decided = (c: Cell | undefined) => !!c && c.verdict !== "inconclusive";

/** Runs `count` paired rounds of `list` (`ic`: the instruction pass, apart from the time pass as in the full method). */
function runRounds(
  out: string,
  list: string[],
  count: number,
  store: Store,
  offset: number,
  ic: boolean,
) {
  const seen = runPaired(out, [BASE, NEW], list, count, store, offset, {
    FAIR_IC: ic ? "1" : "0",
  });
  if (!ic) loads.push(...seen);
}

for (const look of LOOKS) {
  log(`rounds ${done + 1}-${look.rounds}: ${active.join(",")}`);
  runRounds(
    `${DIR}/look-${look.rounds}.json`,
    active,
    look.rounds - done,
    samples,
    done,
    false,
  );
  done = look.rounds;
  for (const row of active) {
    cells[row] ??= {};
    for (const [col, key] of COLS) {
      const cell = judgeCell(samples, row, key, look.level, true);
      if (cell) cells[row]![col] = cell;
    }
  }
  active = active.filter(
    (row) =>
      samples.has(row) && !COLS.every(([col]) => decided(cells[row]?.[col])),
  );
  if (active.length === 0) break;
}

// Instructions: the thread's instruction count does not move with the machine's load, so a few rounds give a narrow
// interval where time cannot. A cell is "better" / "worse" / "same" only when time and instructions agree (as in
// ic-compare.ts); otherwise both readings are shown.
const measured = rows.filter((row) => samples.has(row));
if (measured.length > 0) {
  log(`instructions, ${IC_ROUNDS} rounds: ${measured.join(",")}`);
  runRounds(`${DIR}/ic.json`, measured, IC_ROUNDS, icSamples, 0, true);
  for (const row of measured) {
    icCells[row] = {};
    for (const [col, , icKey] of COLS) {
      const cell = judgeCell(icSamples, row, icKey, 0.95, false);
      if (cell) icCells[row]![col] = cell;
    }
  }
}

/** One verdict from time and instructions. */
function verdictOf(time: Cell | undefined, ins: Cell | undefined) {
  if (!time) return "no data";
  if (time.verdict.startsWith("no outcome")) return time.verdict;
  if (ins && time.verdict === ins.verdict && time.verdict !== "inconclusive")
    return time.verdict;
  return "inconclusive";
}

const date = new Date().toISOString();
const loadMedian = loads.length ? med(loads) : 0;
const warm = Number(process.env.FAIR_WARM ?? 2);
const results: Record<string, Record<string, unknown>> = {};
for (const row of rows)
  for (const [col] of COLS) {
    const time = cells[row]?.[col];
    if (!time) continue;
    const ins = icCells[row]?.[col];
    (results[row] ??= {})[col] = { verdict: verdictOf(time, ins), time, ins };
  }
const summary = {
  mode: "quick",
  date,
  base: { ref: base.label, commit: base.commit },
  new: { ref: next.label, commit: next.commit },
  changed,
  rows,
  warm,
  icRounds: IC_ROUNDS,
  load: { median: loadMedian, max: loads.length ? Math.max(...loads) : 0 },
  cells: results,
};
writeFileSync(`${DIR}/quick-summary.json`, JSON.stringify(summary, null, 2));

// The ledger of the artifact's "updated" column: the latest measurement of each row and column.
const ledgerFile = `${W}/out/measured.json`;
const ledger = existsSync(ledgerFile)
  ? JSON.parse(readFileSync(ledgerFile, "utf8"))
  : {};
for (const [row, byCol] of Object.entries(cells))
  for (const [col, c] of Object.entries(byCol)) {
    const ins = icCells[row]?.[col];
    (ledger[row] ??= {})[col] = {
      date,
      mode: "quick",
      base: base.commit,
      new: next.commit,
      verdict: verdictOf(c, ins),
      time: {
        verdict: c.verdict,
        pct: c.pct,
        ci: c.ci,
        level: c.level,
        rounds: c.rounds,
        spread: c.spread,
      },
      ins: ins && {
        verdict: ins.verdict,
        pct: ins.pct,
        ci: ins.ci,
        rounds: ins.rounds,
        spread: ins.spread,
      },
      loadMedian,
      maxLoad: c.maxLoad,
      warm,
    };
  }
writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));

const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} %`;
/** A reading of one cell: its change when decided, else how far it can have moved or which way it leans. */
const reading = (c: Cell | undefined) => {
  if (!c) return "no data";
  if (c.verdict === "better" || c.verdict === "worse")
    return `${c.verdict} ${pct(c.pct)}`;
  if (c.verdict !== "inconclusive") return c.verdict;
  const [lo, hi] = c.ci;
  if (lo <= 0 && hi >= 0)
    return `no change beyond ±${Math.ceil(Math.max(-lo, hi))} %`;
  return lo > 0
    ? `leans worse (${pct(lo)} to ${pct(hi)})`
    : `leans better (${pct(hi)} to ${pct(lo)})`;
};
console.log(
  `\nQUICK: ${next.label} (${next.commit}) against ${base.label} (${base.commit})`,
);
console.log(
  `load median ${loadMedian.toFixed(1)} · warm-up ${warm} · time up to ${LOOKS.at(-1)!.rounds} rounds, instructions ${IC_ROUNDS} · not the full method: for important changes run docnode-compare.ts\n`,
);
console.log(
  "| Row | Column | Verdict | Time | Time interval | Instructions | Rounds |",
);
console.log("|---|---|---|---|---|---|---|");
for (const row of rows)
  for (const [col] of COLS) {
    const c = cells[row]?.[col];
    const ins = icCells[row]?.[col];
    if (!c) {
      console.log(`| ${row} | ${col} | no data | | | | |`);
      continue;
    }
    console.log(
      `| ${row} | ${col} | ${verdictOf(c, ins)} | ${reading(c)} | [${pct(c.ci[0])}, ${pct(c.ci[1])}] ${Math.round(c.level * 100)} % | ${reading(ins)} | ${c.rounds} + ${ins?.rounds ?? 0} |`,
    );
  }
