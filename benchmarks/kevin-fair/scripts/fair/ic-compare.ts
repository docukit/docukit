// DocNode against DocNode (NEW against BASE): time and thread instructions, same statistics.
// A change counts as better / worse only if time and instructions point the same way (both "better" or both "worse").
// A run still busy after its retries (meta.repeat) gives "no verdict: busy machine".
// usage: BASE=<base> NEW=<new> node ic-compare.ts <dir>   (needs kevin-A/B, ic-A/B and, if present, docs-A/B, docs-ic-A/B)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { judge, roundMap, num, NO_OUTCOME_TINY } from "./stats.ts";
const DIR = process.argv[2]!,
  NEW = process.env.NEW!,
  BASE = process.env.BASE!;
if (!NEW || !BASE) throw new Error("set BASE and NEW");
const load = (f: string) =>
  existsSync(`${DIR}/${f}`)
    ? JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"))
    : undefined;
const series = (a: any, b: any, row: string, lib: string, key: string) => {
  const get = (run: any) =>
    roundMap(run?.timing?.[row]?.[lib]?.samples, (raw) =>
      raw[`${row} (${key})`] === undefined
        ? undefined
        : num(raw[`${row} (${key})`]),
    );
  return { A: get(a), B: get(b) };
};
const judgement = (t: string, i: string) =>
  t === NO_OUTCOME_TINY
    ? "no outcome (both < 0.1 ms)"
    : t.startsWith("no verdict")
      ? t
      : i.startsWith("no verdict")
        ? `${i} (instructions)`
        : t === "better" && i === "better"
          ? "better"
          : t === "worse" && i === "worse"
            ? "worse"
            : t === "equivalent" && i === "equivalent"
              ? "same"
              : t === "inconclusive" || i === "inconclusive"
                ? "inconclusive"
                : "inconclusive (time and instructions disagree)";
const busy = (...runs: any[]) => runs.some((r) => r?.meta?.repeat);
const out: any = { new: NEW, base: BASE, kevin: {}, docs: {} };
const [kA, kB, iA, iB] = [
  load("kevin-A.json"),
  load("kevin-B.json"),
  load("ic-A.json"),
  load("ic-B.json"),
];
const KCOLS = [
  ["time", "time exact", "time ins"],
  ["save", "encodeTime exact", "encodeTime ins"],
  ["loadNoGc", "loadNoGc exact", "loadNoGc ins"],
  ["loadKevin", "parseTime exact", "parseTime ins"],
];
if (kA && kB && iA && iB)
  for (const row of Object.keys(iA.timing)) {
    const full =
      Object.keys(kA.timing).find((r) =>
        r.startsWith(row.slice(0, row.indexOf("]") + 1)),
      ) ?? row;
    for (const [col, tk, ik] of KCOLS as [string, string, string][]) {
      const t = judge(
        series(kA, kB, full, NEW, tk),
        { [BASE]: series(kA, kB, full, BASE, tk) },
        { tiny: true, busy: busy(kA, kB) },
      );
      const i = judge(
        series(iA, iB, row, NEW, ik),
        { [BASE]: series(iA, iB, row, BASE, ik) },
        { tiny: false, busy: busy(iA, iB) },
      );
      (out.kevin[row] ??= {})[col] = {
        time: t,
        ins: i,
        judgement: judgement(t.outcome, i.outcome),
      };
    }
  }
const [dA, dB, diA, diB] = [
  load("docs-A.json"),
  load("docs-B.json"),
  load("docs-ic-A.json"),
  load("docs-ic-B.json"),
];
if (dA && dB && diA && diB)
  for (const kind of Object.keys(diA.timing))
    for (const col of ["load", "save", "fromJSON", "toJSON"]) {
      const g = (a: any, b: any, lib: string, k: string) => {
        const get = (run: any) =>
          roundMap(run.timing[kind]?.[lib]?.samples, (raw) =>
            typeof raw[k] === "number" ? raw[k] : undefined,
          );
        return { A: get(a), B: get(b) };
      };
      const t = judge(
        g(dA, dB, NEW, col),
        { [BASE]: g(dA, dB, BASE, col) },
        { tiny: true, busy: busy(dA, dB) },
      );
      const i = judge(
        g(diA, diB, NEW, col + "Ins"),
        { [BASE]: g(diA, diB, BASE, col + "Ins") },
        { tiny: false, busy: busy(diA, diB) },
      );
      (out.docs[kind] ??= {})[col] = {
        time: t,
        ins: i,
        judgement: judgement(t.outcome, i.outcome),
      };
    }
writeFileSync(`${DIR}/fair-ic-summary.json`, JSON.stringify(out, null, 1));
console.log("ic summary written");
