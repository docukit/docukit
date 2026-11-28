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
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { med, num, quantile } from "./stats.ts";

const W = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
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
const MIN_PCT = 2;
const TINY_MS = 0.1;
/** Cumulative rounds of each look, and the interval level used there. */
const LOOKS = [
  { rounds: 10, level: 0.99 },
  { rounds: 20, level: 0.99 },
  { rounds: 40, level: 0.95 },
];
/** Two-sided Student t quantiles by degrees of freedom (1-29), for 95 % and 99 %. */
const T: Record<number, number[]> = {
  0.95: [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08,
    2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045,
  ],
  0.99: [
    63.657, 9.925, 5.841, 4.604, 4.032, 3.707, 3.499, 3.355, 3.25, 3.169, 3.106,
    3.055, 3.012, 2.977, 2.947, 2.921, 2.898, 2.878, 2.861, 2.845, 2.831, 2.819,
    2.807, 2.797, 2.787, 2.779, 2.771, 2.763, 2.756,
  ],
};

/** The root of the repository W is in: paths like packages/docnode are read from there. */
const TOP = execFileSync("git", ["-C", W, "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const git = (...a: string[]) =>
  execFileSync("git", ["-C", TOP, ...a], { encoding: "utf8" }).trim();
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** A tree to bundle, its commit (when known) and its packages/docnode/src. */
function treeOf(arg: string) {
  if (existsSync(arg) && statSync(arg).isDirectory()) {
    const dir = resolve(arg);
    let commit = "";
    try {
      commit = execFileSync(
        "git",
        ["-C", dir, "rev-parse", "--short", "HEAD"],
        { encoding: "utf8" },
      ).trim();
      const dirty = execFileSync(
        "git",
        ["-C", dir, "status", "--porcelain", "--", "packages/docnode/src"],
        { encoding: "utf8" },
      ).trim();
      if (dirty) commit += "+dirty";
    } catch {
      commit = "(no git)";
    }
    return { label: arg, dir, commit, sha: undefined as string | undefined };
  }
  const sha = git("rev-parse", "--verify", `${arg}^{commit}`);
  const dir = `${W}/tmp/quick-trees/${sha}`;
  if (!existsSync(`${dir}/packages/docnode/src`)) {
    mkdirSync(dir, { recursive: true });
    // git archive writes no ref and touches no checkout.
    const tar = spawnSync(
      "git",
      ["-C", TOP, "archive", sha, "packages/docnode"],
      { maxBuffer: 1 << 30 },
    );
    if (tar.status !== 0) throw new Error(`git archive ${arg} failed`);
    spawnSync("tar", ["-x", "-C", dir], { input: tar.stdout });
  }
  return { label: arg, dir, commit: sha.slice(0, 8), sha };
}

/** The files of packages/docnode/src that differ between the two trees. */
function changedFiles(
  a: ReturnType<typeof treeOf>,
  b: ReturnType<typeof treeOf>,
) {
  if (a.sha && b.sha)
    return git(
      "diff",
      "--name-only",
      a.sha,
      b.sha,
      "--",
      "packages/docnode/src",
    )
      .split("\n")
      .filter(Boolean);
  const list = (root: string, at = ""): string[] =>
    readdirSync(join(root, at), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? list(root, join(at, e.name)) : [join(at, e.name)],
    );
  const src = "packages/docnode/src";
  const files = new Set([...list(join(a.dir, src)), ...list(join(b.dir, src))]);
  return [...files]
    .filter((f) => {
      const x = join(a.dir, src, f),
        y = join(b.dir, src, f);
      return (
        !existsSync(x) ||
        !existsSync(y) ||
        !readFileSync(x).equals(readFileSync(y))
      );
    })
    .map((f) => `${src}/${f}`);
}

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
mkdirSync(`${W}/bundles`, { recursive: true });
const BASE = "qc-base",
  NEW = "qc-new";
for (const [name, tree] of [
  [BASE, base],
  [NEW, next],
] as const) {
  const status = spawnSync(
    process.execPath,
    [
      `${W}/scripts/build.ts`,
      tree.dir,
      `${W}/scripts/docnodeAdapter.ts`,
      `${W}/bundles/${name}.mjs`,
    ],
    { env: { ...process.env, W }, stdio: "inherit" },
  ).status;
  if (status !== 0) throw new Error(`could not bundle ${tree.label}`);
}

type Sample = { round: number; load1min: number; raw: Record<string, unknown> };
/** row -> lib -> samples, with rounds numbered across the looks. */
type Store = Map<string, Map<string, Sample[]>>;
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
  blocks: number;
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
  const get = (lib: string) => {
    const m = new Map<number, number>();
    for (const s of store.get(row)?.get(lib) ?? []) {
      const v = s.raw[`${row} (${key})`];
      if (v !== undefined) m.set(s.round, num(v));
    }
    return m;
  };
  const b = get(BASE),
    n = get(NEW);
  // Two-round blocks: both orders of the pair in each.
  const blocks = new Map<number, { b: number; n: number; k: number }>();
  const roundLoads: number[] = [];
  for (const [round, x] of n) {
    const y = b.get(round);
    if (y === undefined) continue;
    const k = Math.floor(round / 2);
    const block = blocks.get(k) ?? blocks.set(k, { b: 0, n: 0, k: 0 }).get(k)!;
    block.b += y;
    block.n += x;
    block.k++;
  }
  for (const s of store.get(row)?.get(NEW) ?? []) roundLoads.push(s.load1min);
  const full = [...blocks.values()].filter((x) => x.k === 2);
  if (full.length < 2) return undefined;
  const logs = full.map((x) => Math.log(x.n / x.b));
  const mean = logs.reduce((a, c) => a + c, 0) / logs.length;
  const sd = Math.sqrt(
    logs.reduce((a, c) => a + (c - mean) ** 2, 0) / (logs.length - 1),
  );
  const t = T[level]![Math.min(logs.length - 1, 29) - 1]!;
  const half = (t * sd) / Math.sqrt(logs.length);
  const pct = (Math.exp(mean) - 1) * 100;
  const ci: [number, number] = [
    (Math.exp(mean - half) - 1) * 100,
    (Math.exp(mean + half) - 1) * 100,
  ];
  const baseMs = [...b.values()].reduce((a, c) => a + c, 0) / b.size;
  const newMs = [...n.values()].reduce((a, c) => a + c, 0) / n.size;
  const ratios = full.map((x) => (x.n / x.b - 1) * 100);
  const verdict =
    tiny && baseMs < TINY_MS && newMs < TINY_MS
      ? "no outcome (both < 0.1 ms)"
      : ci[1] < -MIN_PCT
        ? "better"
        : ci[0] > MIN_PCT
          ? "worse"
          : ci[0] >= -MIN_PCT && ci[1] <= MIN_PCT
            ? "same"
            : "inconclusive";
  return {
    verdict,
    pct,
    ci,
    level,
    blocks: full.length,
    rounds: full.length * 2,
    baseMs,
    newMs,
    // How much the pairs disagree: the 10-90 % range of the block ratios, in points.
    spread: quantile(ratios, 0.9) - quantile(ratios, 0.1),
    maxLoad: Math.max(...roundLoads),
  };
}
const decided = (c: Cell | undefined) => !!c && c.verdict !== "inconclusive";

/**
 * Runs `count` paired rounds of `list` into `out` and adds their samples to `store`, numbering rounds from `offset`.
 * `ic`: the instruction pass (FAIR_IC=1), kept apart from the time pass as in the full method.
 */
function runRounds(
  out: string,
  list: string[],
  count: number,
  store: Store,
  offset: number,
  ic: boolean,
) {
  const status = spawnSync(process.execPath, [`${W}/scripts/fair/run.ts`], {
    env: {
      ...process.env,
      W,
      OUT: out,
      SUBJECTS: `${BASE},${NEW}`,
      ROWS: list.join(","),
      ROUNDS: String(count),
      FAIR_WARM: process.env.FAIR_WARM ?? "2",
      FAIR_IC: ic ? "1" : "0",
    },
    stdio: "inherit",
  }).status;
  // 3 = "busy machine" for the full method; here the pairs carry the load, so the rounds count.
  if (status !== 0 && status !== 3)
    throw new Error(`run.ts failed (${status})`);
  const data = JSON.parse(readFileSync(out, "utf8"));
  if (!ic) for (const l of data.meta.loads) loads.push(l.load1min);
  for (const [name, byLib] of Object.entries<any>(data.timing)) {
    const row = name.slice(0, name.indexOf("]") + 1);
    const byRow = store.get(row) ?? store.set(row, new Map()).get(row)!;
    for (const [lib, value] of Object.entries<any>(byLib)) {
      const samplesOf = byRow.get(lib) ?? byRow.set(lib, []).get(lib)!;
      for (const s of value.samples)
        samplesOf.push({
          ...s,
          round: s.round + offset,
          raw: renamed(s.raw, name, row),
        });
    }
  }
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

/** The raw keys of a sample, named by the row's short name (`[B1.8]`) instead of its full title. */
function renamed(raw: Record<string, unknown>, name: string, row: string) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k.replace(name, row)] = v;
  return out;
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
