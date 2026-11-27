// The fixed statistics of the method:
//  - median per cell; % = median(lib) / median(reference) - 1;
//  - 95 % bootstrap interval of that %, 4000 resamples, seed 12345 (the generator is re-seeded at every interval,
//    so the result of a cell never depends on the order in which the cells are computed);
//  - verdict: "win" if the whole interval is below -2 %, "loss" if it is above +2 %, else "tie".
export const MIN_PCT = 2,
  RESAMPLES = 4000,
  SEED = 12345;
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
export const pct = (d: number[], r: number[]) => (med(d) / med(r) - 1) * 100;
export const bootstrap = (d: number[], r: number[]): [number, number] => {
  const rnd = makeRnd(SEED);
  const rs = (xs: number[]) => xs.map(() => xs[Math.floor(rnd() * xs.length)]!);
  const v: number[] = [];
  for (let i = 0; i < RESAMPLES; i++) v.push(pct(rs(d), rs(r)));
  return [quantile(v, 0.025), quantile(v, 0.975)];
};
export type Verdict = "win" | "loss" | "tie";
export const verdictOf = (lo: number, hi: number): Verdict =>
  hi < -MIN_PCT ? "win" : lo > MIN_PCT ? "loss" : "tie";
/** Green or red only if A and B agree. */
export const finalVerdict = (a: Verdict, b: Verdict) =>
  a === b ? a : "tie (unstable)";
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

export type Cell = {
  median: number;
  min: number;
  max: number;
  n: number;
  spread: number;
  ref?: string;
  refMedian?: number;
  pct?: number | null;
  ci?: [number, number] | null;
  pctA?: number | null;
  ciA?: [number, number] | null;
  verdictA?: Verdict | null;
  pctB?: number | null;
  ciB?: [number, number] | null;
  verdictB?: Verdict | null;
  verdict: string;
};

/** Compare one library against the reference, in two independent runs. `tiny` = a column in ms: no % when both medians < 0.1. */
export function compareCell(
  libA: number[],
  libB: number[],
  refA: number[],
  refB: number[],
  tiny: boolean,
): Omit<Cell, "median" | "min" | "max" | "n" | "spread" | "ref" | "refMedian"> {
  const lib = [...libA, ...libB],
    ref = [...refA, ...refB];
  if (
    !lib.length ||
    !ref.length ||
    (tiny && med(lib) < 0.1 && med(ref) < 0.1) ||
    med(ref) === 0
  )
    return {
      pct: null,
      ci: null,
      pctA: null,
      pctB: null,
      ciA: null,
      ciB: null,
      verdictA: null,
      verdictB: null,
      verdict: "no %",
    };
  const per = (d: number[], r: number[]) => {
    if (d.length < 3 || r.length < 3) return { p: null, ci: null, v: null };
    const ci = bootstrap(d, r);
    return { p: pct(d, r), ci, v: verdictOf(ci[0], ci[1]) };
  };
  const a = per(libA, refA),
    b = per(libB, refB);
  const verdict = a.v && b.v ? finalVerdict(a.v, b.v) : (a.v ?? b.v ?? "no %");
  return {
    pct: pct(lib, ref),
    ci: bootstrap(lib, ref),
    pctA: a.p,
    ciA: a.ci,
    verdictA: a.v,
    pctB: b.p,
    ciB: b.ci,
    verdictB: b.v,
    verdict,
  };
}
