// DocNode against DocNode (NEW against BASE): time and thread instructions, same statistics.
// A change counts as better / worse only if time and instructions point the same way (both "win" or both "loss").
// usage: BASE=<base> NEW=<new> node ic-compare.ts <dir>   (needs kevin-A/B, ic-A/B and, if present, docs-A/B, docs-ic-A/B)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { compareCell, num } from "./stats.ts";
const DIR = process.argv[2]!,
  NEW = process.env.NEW!,
  BASE = process.env.BASE!;
if (!NEW || !BASE) throw new Error("set BASE and NEW");
const load = (f: string) =>
  existsSync(`${DIR}/${f}`)
    ? JSON.parse(readFileSync(`${DIR}/${f}`, "utf8"))
    : undefined;
const samples = (run: any, row: string, lib: string, key: string) =>
  (run?.timing?.[row]?.[lib]?.samples ?? [])
    .map((s: any) => s.raw[`${row} (${key})`])
    .filter((v: unknown) => v !== undefined)
    .map(num) as number[];
const judge = (t: string, i: string) =>
  t === "win" && i === "win"
    ? "better"
    : t === "loss" && i === "loss"
      ? "worse"
      : t === "tie" && i === "tie"
        ? "same"
        : t === "tie (unstable)" || i === "tie (unstable)"
          ? "inconclusive (unstable)"
          : "inconclusive (time and instructions disagree)"; // DocNode against DocNode (NEW against BASE): time and thread instructions, same statistics.
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
      const t = compareCell(
        samples(kA, full, NEW, tk),
        samples(kB, full, NEW, tk),
        samples(kA, full, BASE, tk),
        samples(kB, full, BASE, tk),
        true,
      );
      const i = compareCell(
        samples(iA, row, NEW, ik),
        samples(iB, row, NEW, ik),
        samples(iA, row, BASE, ik),
        samples(iB, row, BASE, ik),
        false,
      );
      (out.kevin[row] ??= {})[col] = {
        time: t,
        ins: i,
        judgement:
          t.verdict === "no %"
            ? "no % (both < 0.1 ms)"
            : judge(t.verdict, i.verdict),
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
      const g = (run: any, lib: string, k: string) =>
        (run.timing[kind]?.[lib]?.samples ?? [])
          .map((s: any) => s.raw[k])
          .filter((v: unknown): v is number => typeof v === "number");
      const t = compareCell(
        g(dA, NEW, col),
        g(dB, NEW, col),
        g(dA, BASE, col),
        g(dB, BASE, col),
        true,
      );
      const i = compareCell(
        g(diA, NEW, col + "Ins"),
        g(diB, NEW, col + "Ins"),
        g(diA, BASE, col + "Ins"),
        g(diB, BASE, col + "Ins"),
        false,
      );
      (out.docs[kind] ??= {})[col] = {
        time: t,
        ins: i,
        judgement:
          t.verdict === "no %"
            ? "no % (both < 0.1 ms)"
            : judge(t.verdict, i.verdict),
      };
    }
writeFileSync(`${DIR}/fair-ic-summary.json`, JSON.stringify(out, null, 1));
console.log("ic summary written");
