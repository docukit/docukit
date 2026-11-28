// What the quick commands share (quick-compare.ts, quick-table.ts): trees from git refs, bundles, paired rounds and
// the paired statistic. See the README ("Quick check").
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { num, quantile } from "./stats.ts";

export const W = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The root of the repository W is in: paths like packages/docnode are read from there. */
const TOP = execFileSync("git", ["-C", W, "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();
const git = (...a: string[]) =>
  execFileSync("git", ["-C", TOP, ...a], { encoding: "utf8" }).trim();
export const log = (...a: unknown[]) =>
  console.log(new Date().toISOString(), ...a);

export const MIN_PCT = 2;
export const TINY_MS = 0.1;
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

export type Tree = {
  label: string;
  dir: string;
  commit: string;
  sha: string | undefined;
};

/** A tree to bundle from a git ref (exported with git archive, no checkout) or a checkout directory. */
export function treeOf(arg: string): Tree {
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
    return { label: arg, dir, commit, sha: undefined };
  }
  const sha = git("rev-parse", "--verify", `${arg}^{commit}`);
  const dir = `${W}/tmp/quick-trees/${sha}`;
  if (!existsSync(`${dir}/packages/docnode/src`)) {
    mkdirSync(dir, { recursive: true });
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

/** The files of packages/docnode/src that differ between two trees. */
export function changedFiles(a: Tree, b: Tree) {
  const src = "packages/docnode/src";
  if (a.sha && b.sha)
    return git("diff", "--name-only", a.sha, b.sha, "--", src)
      .split("\n")
      .filter(Boolean);
  const list = (root: string, at = ""): string[] =>
    readdirSync(join(root, at), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? list(root, join(at, e.name)) : [join(at, e.name)],
    );
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

/** Whether a tree has the `text()` state (milestone 2), so it can run the text rows. */
export const hasText = (tree: Tree) =>
  existsSync(`${tree.dir}/packages/docnode/src/text.ts`);

/** Bundles a tree with the crdt-benchmarks adapter into bundles/<name>.mjs. */
export function bundle(name: string, tree: Tree) {
  mkdirSync(`${W}/bundles`, { recursive: true });
  const status = spawnSync(
    process.execPath,
    [
      `${W}/scripts/build.ts`,
      tree.dir,
      `${W}/scripts/docnodeAdapter.ts`,
      `${W}/bundles/${name}.mjs`,
    ],
    { env: { ...process.env, W }, stdio: ["ignore", "ignore", "inherit"] },
  ).status;
  if (status !== 0) throw new Error(`could not bundle ${tree.label}`);
}

export type Sample = {
  round: number;
  load1min: number;
  raw: Record<string, unknown>;
};
/** row (short name, `[B1.8]`) -> library -> samples, with rounds numbered across runs. */
export type Store = Map<string, Map<string, Sample[]>>;

/**
 * Runs `count` rounds of `rows` for `subjects` with run.ts (each round runs every subject once, in alternating
 * order, with two warm-up passes) and adds the samples to `store`, numbering rounds from `offset`. Returns the
 * loads seen. `env`: more variables for run.ts (FAIR_IC, MODE).
 */
export function runRounds(
  out: string,
  subjects: string[],
  rows: string[],
  count: number,
  store: Store,
  offset: number,
  env: Record<string, string> = {},
) {
  const status = spawnSync(process.execPath, [`${W}/scripts/fair/run.ts`], {
    env: {
      ...process.env,
      W,
      OUT: out,
      SUBJECTS: subjects.join(","),
      ROWS: rows.join(","),
      ROUNDS: String(count),
      FAIR_WARM: process.env.FAIR_WARM ?? "2",
      ...env,
    },
    stdio: ["ignore", "inherit", "inherit"],
  }).status;
  // 3 = "busy machine" for the full method; here the rounds are paired, so they count.
  if (status !== 0 && status !== 3)
    throw new Error(`run.ts failed (${status})`);
  const data = JSON.parse(readFileSync(out, "utf8"));
  for (const [name, byLib] of Object.entries<any>(data.timing)) {
    const row = name.slice(0, name.indexOf("]") + 1);
    const byRow = store.get(row) ?? store.set(row, new Map()).get(row)!;
    for (const [lib, value] of Object.entries<any>(byLib)) {
      const list = byRow.get(lib) ?? byRow.set(lib, []).get(lib)!;
      for (const s of value.samples) {
        const raw: Record<string, unknown> = {};
        for (const [k, v] of Object.entries<unknown>(s.raw))
          raw[k.replace(name, row)] = v;
        list.push({ ...s, round: s.round + offset, raw });
      }
    }
  }
  return (data.meta.loads as { load1min: number }[]).map((l) => l.load1min);
}

/** The values of one library in one cell, by round. */
export function valuesOf(store: Store, row: string, lib: string, key: string) {
  const m = new Map<number, number>();
  for (const s of store.get(row)?.get(lib) ?? []) {
    const v = s.raw[`${row} (${key})`];
    if (v !== undefined) m.set(s.round, num(v));
  }
  return m;
}

export type Paired = {
  pct: number;
  ci: [number, number];
  level: number;
  rounds: number;
  libMean: number;
  refMean: number;
  /** How much the pairs disagree: the 10-90 % range of the block ratios, in points. */
  spread: number;
};

/**
 * `lib` against `ref`, paired by round: the mean of ln(lib / ref) over two-round blocks (a block holds both orders
 * of the pair), with a Student t interval at `level`. undefined with fewer than two full blocks.
 */
export function paired(
  lib: Map<number, number>,
  ref: Map<number, number>,
  level: number,
): Paired | undefined {
  const blocks = new Map<number, { l: number; r: number; k: number }>();
  for (const [round, x] of lib) {
    const y = ref.get(round);
    if (y === undefined) continue;
    const k = Math.floor(round / 2);
    const b = blocks.get(k) ?? blocks.set(k, { l: 0, r: 0, k: 0 }).get(k)!;
    b.l += x;
    b.r += y;
    b.k++;
  }
  const full = [...blocks.values()].filter(
    (b) => b.k === 2 && b.l > 0 && b.r > 0,
  );
  if (full.length < 2) return undefined;
  const logs = full.map((b) => Math.log(b.l / b.r));
  const mean = logs.reduce((a, c) => a + c, 0) / logs.length;
  const sd = Math.sqrt(
    logs.reduce((a, c) => a + (c - mean) ** 2, 0) / (logs.length - 1),
  );
  const t = T[level]![Math.min(logs.length - 1, 29) - 1]!;
  const half = (t * sd) / Math.sqrt(logs.length);
  const ratios = full.map((b) => (b.l / b.r - 1) * 100);
  const avg = (m: Map<number, number>) =>
    [...m.values()].reduce((a, c) => a + c, 0) / m.size;
  return {
    pct: (Math.exp(mean) - 1) * 100,
    ci: [(Math.exp(mean - half) - 1) * 100, (Math.exp(mean + half) - 1) * 100],
    level,
    rounds: full.length * 2,
    libMean: avg(lib),
    refMean: avg(ref),
    spread: quantile(ratios, 0.9) - quantile(ratios, 0.1),
  };
}

/** better / worse / same / inconclusive from an interval, with the ±2 % band of the full method. */
export const outcomeOf = (ci: [number, number]) =>
  ci[1] < -MIN_PCT
    ? "better"
    : ci[0] > MIN_PCT
      ? "worse"
      : ci[0] >= -MIN_PCT && ci[1] <= MIN_PCT
        ? "same"
        : "inconclusive";

/**
 * `lib` against `ref` measured in another run (Welch's interval on the mean of ln values): for Yjs values reused from
 * the cache. Not paired, so load that differs between the two runs moves it; quick-table prints the cache's date.
 */
export function unpaired(
  lib: Map<number, number>,
  ref: Map<number, number>,
  level: number,
): Paired | undefined {
  const x = [...lib.values()].filter((v) => v > 0).map(Math.log);
  const y = [...ref.values()].filter((v) => v > 0).map(Math.log);
  if (x.length < 2 || y.length < 2) return undefined;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const variance = (a: number[], m: number) =>
    a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1);
  const mx = mean(x),
    my = mean(y);
  const vx = variance(x, mx) / x.length,
    vy = variance(y, my) / y.length;
  const se = Math.sqrt(vx + vy);
  const df =
    se === 0
      ? 29
      : (vx + vy) ** 2 / (vx ** 2 / (x.length - 1) + vy ** 2 / (y.length - 1));
  const t = T[level]![Math.max(1, Math.min(Math.floor(df), 29)) - 1]!;
  const avg = (m: Map<number, number>) =>
    [...m.values()].reduce((a, c) => a + c, 0) / m.size;
  const ratios = [...lib.values()].map((v) => (v / Math.exp(my) - 1) * 100);
  return {
    pct: (Math.exp(mx - my) - 1) * 100,
    ci: [
      (Math.exp(mx - my - t * se) - 1) * 100,
      (Math.exp(mx - my + t * se) - 1) * 100,
    ],
    level,
    rounds: Math.min(x.length, y.length),
    libMean: avg(lib),
    refMean: avg(ref),
    spread: quantile(ratios, 0.9) - quantile(ratios, 0.1),
  };
}
