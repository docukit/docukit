// The fixed statistics of the method (README rule 7).
//  - Estimate: the arithmetic mean of the exact samples. Libraries are compared as a ratio of means:
//    % = mean(lib) / mean(reference) - 1. The median is kept as a secondary number.
//  - Interval: paired bootstrap of matched two-round blocks (rounds 2k and 2k+1, so the alternating order stays inside
//    a block), resampled separately within run A and run B and pooled. 4,000 resamples, seed 12345, re-seeded for every
//    comparison, so a cell never depends on the order in which cells are computed.
//  - Reference = the better of two libraries (Yjs 13 / Yjs 14): both comparisons use simultaneous Bonferroni intervals
//    (97.5 % each). Because "against the better one" = the larger of the two ratios, its interval is
//    [max of the lower ends, max of the upper ends], which keeps 95 % joint coverage for the choice.
//  - Outcome: "better" / "worse" only if the whole interval is beyond -2 % / +2 %; "equivalent" only if it is wholly
//    inside +-2 %; otherwise "inconclusive". Both means under 0.1 ms: absolute difference only, no outcome.
//  - A and B are a drift check, not two votes: no verdict if they fall on opposite practical sides (one beyond +2 %,
//    the other beyond -2 %) or the interval of their difference lies wholly outside +-2 points.
//  - Flags (shown, never change the outcome): "low precision" when a mean's interval extends more than 5 % from the
//    mean; "fragile" when omitting one matched round moves the comparison by more than 2 points.
export const MIN_PCT = 2,
  RESAMPLES = 4000,
  SEED = 12345,
  LOW_PRECISION_PCT = 5,
  FRAGILE_POINTS = 2,
  TINY_MS = 0.1;
export const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
export const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b),
    n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};
export const quantile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.round(p * (s.length - 1))]!;
};
const makeRnd = (seed0: number) => {
  let seed = seed0;
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
export const spread = (xs: number[]) =>
  ((quantile(xs, 0.9) - quantile(xs, 0.1)) / med(xs)) * 100;

const UNIT: Record<string, number> = {
  B: 1,
  bytes: 1,
  kB: 1e3,
  MB: 1e6,
  GB: 1e9,
  ms: 1,
};
/** "32.23 bytes" / "810.90 kB" / "6.97 ms" / a number -> number. */
export const num = (v: unknown) => {
  if (typeof v === "number") return v;
  const m = /([\d.]+)\s*(\w*)/.exec(String(v))!;
  return Number(m[1]) * (UNIT[m[2]!] ?? 1);
};

/** The samples of one library in one cell, per run: round -> value. */
export type Runs = { A: Map<number, number>; B: Map<number, number> };
/** Samples of a run (`{ round, raw }`) -> round -> value, skipping missing values. */
export const roundMap = (
  samples: { round: number; raw: any }[] | undefined,
  get: (raw: any) => number | undefined,
) => {
  const m = new Map<number, number>();
  for (const s of samples ?? []) {
    const v = get(s.raw);
    if (typeof v === "number" && !Number.isNaN(v)) m.set(s.round, v);
  }
  return m;
};
export const allValues = (r: Runs) => [...r.A.values(), ...r.B.values()];

export type Outcome = "better" | "worse" | "equivalent" | "inconclusive";
export const outcomeOf = (lo: number, hi: number): Outcome =>
  hi < -MIN_PCT
    ? "better"
    : lo > MIN_PCT
      ? "worse"
      : lo >= -MIN_PCT && hi <= MIN_PCT
        ? "equivalent"
        : "inconclusive";
export const DECIDED = new Set(["better", "worse", "equivalent"]);
export const NO_VERDICT_BUSY = "no verdict: busy machine",
  NO_VERDICT_DRIFT = "no verdict: A/B drift",
  NO_OUTCOME_TINY = "no outcome (both means < 0.1 ms)",
  NO_DATA = "no data";

const pctOf = (l: number, r: number) => (l / r - 1) * 100;
type Block = { l: number; r: number; n: number };
/** Matched rounds (both libraries have a sample), grouped in two-round blocks. */
const blocksOf = (lib: Map<number, number>, ref: Map<number, number>) => {
  const by = new Map<number, Block>();
  const pairs: [number, number][] = [];
  for (const [round, x] of lib) {
    const y = ref.get(round);
    if (y === undefined) continue;
    const k = Math.floor(round / 2);
    const b = by.get(k) ?? by.set(k, { l: 0, r: 0, n: 0 }).get(k)!;
    b.l += x;
    b.r += y;
    b.n++;
    pairs.push([x, y]);
  }
  return { blocks: [...by.values()], pairs };
};
const total = (bs: Block[]) =>
  bs.reduce((a, b) => ({ l: a.l + b.l, r: a.r + b.r, n: a.n + b.n }), {
    l: 0,
    r: 0,
    n: 0,
  });
const ciOf = (xs: number[], level: number): [number, number] | null =>
  xs.length
    ? [quantile(xs, (1 - level) / 2), quantile(xs, 1 - (1 - level) / 2)]
    : null;

export type Pair = {
  n: number;
  level: number;
  libMean: number;
  refMean: number;
  pct: number;
  ci: [number, number];
  pctA: number | null;
  ciA: [number, number] | null;
  pctB: number | null;
  ciB: [number, number] | null;
  diffCi: [number, number] | null;
  libMeanCi: [number, number];
  refMeanCi: [number, number];
  maxJackMove: number;
  drift: boolean;
  lowPrecision: boolean;
  fragile: boolean;
};
/** One library against one reference, paired by round. null when there are fewer than 3 matched rounds. */
export function comparePair(lib: Runs, ref: Runs, level = 0.95): Pair | null {
  const a = blocksOf(lib.A, ref.A),
    b = blocksOf(lib.B, ref.B);
  const tA = total(a.blocks),
    tB = total(b.blocks);
  const n = tA.n + tB.n;
  if (n < 3) return null;
  const L = tA.l + tB.l,
    R = tA.r + tB.r;
  const libMean = L / n,
    refMean = R / n;
  const pct = pctOf(L, R);
  const rnd = makeRnd(SEED);
  const draw = (bs: Block[]) => {
    let l = 0,
      r = 0,
      k = 0;
    for (let i = 0; i < bs.length; i++) {
      const x = bs[Math.floor(rnd() * bs.length)]!;
      l += x.l;
      r += x.r;
      k += x.n;
    }
    return { l, r, n: k };
  };
  const pooled: number[] = [],
    pA: number[] = [],
    pB: number[] = [],
    diff: number[] = [],
    lm: number[] = [],
    rm: number[] = [];
  for (let i = 0; i < RESAMPLES; i++) {
    const x = draw(a.blocks),
      y = draw(b.blocks);
    pooled.push(pctOf(x.l + y.l, x.r + y.r));
    lm.push((x.l + y.l) / (x.n + y.n));
    rm.push((x.r + y.r) / (x.n + y.n));
    const va = x.n ? pctOf(x.l, x.r) : null,
      vb = y.n ? pctOf(y.l, y.r) : null;
    if (va !== null) pA.push(va);
    if (vb !== null) pB.push(vb);
    if (va !== null && vb !== null) diff.push(va - vb);
  }
  const pctA = tA.n ? pctOf(tA.l, tA.r) : null,
    pctB = tB.n ? pctOf(tB.l, tB.r) : null;
  const diffCi = ciOf(diff, level);
  const drift =
    pctA !== null &&
    pctB !== null &&
    ((pctA > MIN_PCT && pctB < -MIN_PCT) ||
      (pctA < -MIN_PCT && pctB > MIN_PCT) ||
      (diffCi !== null && (diffCi[0] > MIN_PCT || diffCi[1] < -MIN_PCT)));
  const libMeanCi = ciOf(lm, level)!,
    refMeanCi = ciOf(rm, level)!;
  const reach = (ci: [number, number], m: number) =>
    (Math.max(m - ci[0], ci[1] - m) / Math.abs(m)) * 100;
  // Jackknife: leave one matched round out of the pooled data.
  let maxJackMove = 0;
  for (const [x, y] of [...a.pairs, ...b.pairs])
    maxJackMove = Math.max(maxJackMove, Math.abs(pctOf(L - x, R - y) - pct));
  return {
    n,
    level,
    libMean,
    refMean,
    pct,
    ci: ciOf(pooled, level)!,
    pctA,
    ciA: ciOf(pA, level),
    pctB,
    ciB: ciOf(pB, level),
    diffCi,
    libMeanCi,
    refMeanCi,
    maxJackMove,
    drift,
    lowPrecision:
      reach(libMeanCi, libMean) > LOW_PRECISION_PCT ||
      reach(refMeanCi, refMean) > LOW_PRECISION_PCT,
    fragile: maxJackMove > FRAGILE_POINTS,
  };
}

export type Judged = {
  mean: number;
  median: number;
  n: number;
  ref?: string;
  refMean?: number;
  refMedian?: number;
  pct?: number | null;
  ci?: [number, number] | null;
  level?: number;
  pctA?: number | null;
  pctB?: number | null;
  ciA?: [number, number] | null;
  ciB?: [number, number] | null;
  diffCi?: [number, number] | null;
  absDiff?: number;
  /** % and interval against every reference candidate (both Yjs). */
  vs?: Record<string, { pct: number; ci: [number, number] } | null>;
  outcome: string;
  flags: string[];
};
/**
 * One library against the better of the reference candidates (the one with the lowest mean over all its rounds).
 * `level` is the joint level; with k candidates each comparison uses 1 - (1 - level) / k.
 */
export function judge(
  lib: Runs,
  refs: Record<string, Runs>,
  opts: { tiny: boolean; busy: boolean; level?: number },
): Judged {
  const values = allValues(lib);
  const base = {
    mean: values.length ? mean(values) : NaN,
    median: values.length ? med(values) : NaN,
    n: values.length,
  };
  const cands = Object.keys(refs).filter((k) => allValues(refs[k]!).length);
  if (!values.length || !cands.length)
    return { ...base, outcome: NO_DATA, flags: [] };
  const ref = cands.reduce((x, y) =>
    mean(allValues(refs[y]!)) < mean(allValues(refs[x]!)) ? y : x,
  );
  const refValues = allValues(refs[ref]!);
  const head = {
    ...base,
    ref,
    refMean: mean(refValues),
    refMedian: med(refValues),
  };
  const level = 1 - (1 - (opts.level ?? 0.95)) / cands.length;
  const pairs = Object.fromEntries(
    cands.map((k) => [k, comparePair(lib, refs[k]!, level)]),
  );
  const main = pairs[ref];
  if (!main || main.refMean <= 0)
    return { ...head, pct: null, ci: null, outcome: NO_DATA, flags: [] };
  if (opts.tiny && main.libMean < TINY_MS && main.refMean < TINY_MS)
    return {
      ...head,
      pct: null,
      ci: null,
      absDiff: main.libMean - main.refMean,
      outcome: NO_OUTCOME_TINY,
      flags: [],
    };
  const usable = Object.values(pairs).filter((p): p is Pair => p !== null);
  const ci: [number, number] =
    usable.length > 1
      ? [
          Math.max(...usable.map((p) => p.ci[0])),
          Math.max(...usable.map((p) => p.ci[1])),
        ]
      : main.ci;
  const flags: string[] = [];
  if (main.lowPrecision) flags.push("low precision");
  if (main.fragile) flags.push("fragile");
  return {
    ...head,
    pct: main.pct,
    ci,
    level,
    pctA: main.pctA,
    pctB: main.pctB,
    ciA: main.ciA,
    ciB: main.ciB,
    diffCi: main.diffCi,
    vs: Object.fromEntries(
      cands.map((k) => [
        k,
        pairs[k] ? { pct: pairs[k]!.pct, ci: pairs[k]!.ci } : null,
      ]),
    ),
    outcome: opts.busy
      ? NO_VERDICT_BUSY
      : main.drift
        ? NO_VERDICT_DRIFT
        : outcomeOf(ci[0], ci[1]),
    flags,
  };
}

/**
 * Cross-history rule (second heap history, README rule 13): both histories must give the same decided outcome;
 * anything else is inconclusive.
 */
export const crossHistory = (a: string, b: string) =>
  DECIDED.has(a) && a === b
    ? "robust across the histories tested"
    : "inconclusive";
