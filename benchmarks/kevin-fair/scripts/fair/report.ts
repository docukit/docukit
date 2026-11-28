// Writes <dir>/report.md from the summaries (fair-summary.json, and if present fair-docs-summary.json,
// fair-ic-summary.json and wall.json). Tables only; the reading of the numbers is up to the person who ran it.
// usage: node report.ts <dir>
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { NO_OUTCOME_TINY } from "./stats.ts";
const DIR = process.argv[2]!;
const J = (f: string) =>
  existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
const S = J(`${DIR}/fair-summary.json`),
  D = J(`${DIR}/fair-docs-summary.json`),
  I = J(`${DIR}/fair-ic-summary.json`),
  WALL = J(`${DIR}/wall.json`);
const YJS = new Set(["yjs13", "yjs14", "yjs13xml", "yjs14node"]);
const NAMES: Record<string, string> = {
  yjs13: "Yjs 13",
  yjs14: "Yjs 14",
  yjs13xml: "Yjs 13 (XmlElement)",
  yjs14node: "Yjs 14 (Node)",
};
const name = (lib: string) => NAMES[lib] ?? lib;
const ICON: Record<string, string> = {
  better: "🟢 better",
  worse: "🔴 worse",
  equivalent: "⚪ equivalent",
  inconclusive: "🟡 inconclusive",
  "no verdict: A/B drift": "⛔ no verdict: A/B drift",
  "no verdict: busy machine": "⛔ no verdict: busy machine",
  reference: "ref",
};
const word = (o: string) => ICON[o] ?? o;
const sgn = (p: number) => (p > 0 ? "+" : p < 0 ? "−" : "");
const f1 = (p: number) =>
  `${sgn(p)}${Math.abs(p) < 10 ? Math.abs(p).toFixed(1) : Math.abs(p).toFixed(0)} %`;
const fci = (ci: [number, number] | null | undefined) =>
  ci ? `[${f1(ci[0]).replace(" %", "")}, ${f1(ci[1])}]` : "";
const fmtN = (v: number, unit: string) =>
  unit === "ms"
    ? `${v < 1 ? v.toFixed(3) : v.toFixed(2)} ms`
    : v >= 1e6
      ? `${(v / 1e6).toFixed(2)} MB`
      : v >= 1e3
        ? `${(v / 1e3).toFixed(1)} kB`
        : `${v.toFixed(0)} B`;
const absDiff = (c: any) =>
  `${sgn(c.absDiff)}${Math.abs(c.absDiff).toFixed(3)} ms (no outcome)`;
/** Compact cell: % and outcome; † = qualified by GC placement, ⚑ = flags (see the long tables). */
const cell = (c: any, withOutcome = true) =>
  !c
    ? "—"
    : c.outcome === "reference"
      ? "ref"
      : c.outcome === NO_OUTCOME_TINY
        ? absDiff(c)
        : c.pct === null || c.pct === undefined
          ? "—"
          : withOutcome
            ? `${f1(c.pct)} ${word(c.outcome)}${c.qualifier ? " †" : ""}${c.flags?.length ? " ⚑" : ""}`
            : f1(c.pct);
const lines: string[] = [];
const P = (s = "") => lines.push(s);

P("# Fair Kevin benchmark");
P();
P(
  `Node ${S?.meta?.runs?.kevin?.A?.node ?? "?"}. Estimate = **mean** of the exact samples (median shown as secondary). % = mean / mean of the better Yjs of the same cell (13 or 14, the lower mean) − 1; **negative = better than Yjs**. Interval: pooled paired bootstrap of matched two-round blocks, resampled within A and B; against two Yjs it uses simultaneous 97.5 % intervals, and the interval against the better one is [larger lower end, larger upper end] (95 % joint).`,
);
P();
P(
  "Outcomes: 🟢 better / 🔴 worse = the whole interval beyond −2 % / +2 %; ⚪ equivalent = wholly inside ±2 %; 🟡 inconclusive = otherwise; ⛔ no verdict: A/B drift (A and B on opposite sides of ±2 %, or the interval of their difference wholly outside ±2 points) or busy machine (load > 6 in more than 25 % of the processes after the retries). Both means < 0.1 ms: only the absolute difference. Flags (⚑, never change the outcome): **low precision** (a mean's interval reaches more than 5 % from it), **fragile** (leaving one matched round out moves the % by more than 2 points), **higher allocation during load** (≥ 2× the reference's bytes, no GC cost implied). † = the GC diagnostics pass saw a GC pause inside the window in a share of rounds that differs from the reference by more than 20 points: the outcome holds **in the fixed benchmark sequence; size sensitive to GC placement**.",
);
P();

const TIMED = [
  ["loadNoGc", "load"],
  ["time", "time"],
  ["save", "save"],
] as const;
if (S) {
  const kevinRows: string[] = S.sets.kevin.rows;
  // Each G row right after its B row (G1.8 after B1.8, G1.9 after B1.9).
  const gRows: string[] = S.sets.g?.rows ?? [];
  const rows = kevinRows.flatMap((r) => {
    const g = gRows.find((x) => x.slice(2, 6) === r.slice(2, 6));
    return g ? [r, g] : [r];
  });
  const short = (r: string) =>
    r
      .replace(/^\[(\w+\.\d+)\] /, "$1 ")
      .replace("20√N clients concurrently ", "20√N ")
      .replace(" (Yjs: XmlElement / Node)", " (Yjs nodes)");
  const libs = (S.sets.kevin.libs as string[]).filter((l) => !YJS.has(l));
  const main = ["loadNoGc", "mem", "time", "save", "bytes", "doc", "docRaw"];
  const units: Record<string, string> = Object.fromEntries(
    S.cols.map((c: any) => [c.key, c.unit]),
  );
  const OUTCOMES = [
    "better",
    "worse",
    "equivalent",
    "inconclusive",
    "no verdict: A/B drift",
    "no verdict: busy machine",
    NO_OUTCOME_TINY,
  ];
  P("## Outcomes per library");
  P();
  P(
    "Cells = rows × columns (bytes, stored doc gzip and uncompressed, load without forced GC, memory, time, save). G1.8 and G1.9 included.",
  );
  P();
  P(
    "| Library | 🟢 better | 🔴 worse | ⚪ equivalent | 🟡 inconclusive | ⛔ A/B drift | ⛔ busy | < 0.1 ms | † GC placement | ⚑ flags |",
  );
  P("|---|---|---|---|---|---|---|---|---|---|");
  for (const lib of libs) {
    const n: Record<string, number> = {};
    let q = 0,
      fl = 0;
    for (const r of rows)
      for (const c of main) {
        const x = S.cells[r]?.[c]?.[lib];
        if (!x) continue;
        n[x.outcome] = (n[x.outcome] ?? 0) + 1;
        if (x.qualifier) q++;
        if (x.flags?.length) fl++;
      }
    P(
      `| ${name(lib)} | ${OUTCOMES.map((o) => n[o] ?? 0).join(" | ")} | ${q} | ${fl} |`,
    );
  }
  P();
  P("## One table per library");
  P();
  P(
    "Columns: **bytes/update** = uncompressed, as DocSync sends them; **stored doc** = the saved document, with gzip and uncompressed; **load** = the inner window `load + check` without the harness's forced GC (the outcome column); **load, Kevin** = upstream `parseTime` (includes 2 full forced GCs), shown as % only; **memory** = `memFairWarm`; **time** = the whole row (it includes neither save nor load); **save** = `encodeTime`.",
  );
  P();
  for (const lib of libs) {
    P(`### ${name(lib)}`);
    P();
    P(
      "| Row | bytes/update | stored doc (gzip) | stored doc (uncompressed) | load | load, Kevin (% only) | memory | time | save |",
    );
    P("|---|---|---|---|---|---|---|---|---|");
    for (const r of rows) {
      const c = (k: string, v = true) => cell(S.cells[r]?.[k]?.[lib], v);
      P(
        `| ${short(r)} | ${c("bytes")} | ${c("doc")} | ${c("docRaw")} | ${c("loadNoGc")} | ${c("loadKevin", false)} | ${c("mem")} | ${c("time")} | ${c("save")} |`,
      );
    }
    P();
    P(`#### ${name(lib)}: timed cells`);
    P();
    P(
      "| Row | Column | Mean (median) | Better Yjs: mean (median) | % [interval] | vs Yjs 13 / Yjs 14 | A / B | Outcome | Flags and notes |",
    );
    P("|---|---|---|---|---|---|---|---|---|");
    for (const r of rows)
      for (const [k, label] of TIMED) {
        const c = S.cells[r]?.[k]?.[lib];
        if (!c) continue;
        const vs = c.vs
          ? Object.entries<any>(c.vs)
              .map(([y, v]) => (v ? `${f1(v.pct)} ${fci(v.ci)}` : `— (${y})`))
              .join(" / ")
          : "";
        const ab =
          c.pctA != null && c.pctB != null
            ? `${f1(c.pctA)} / ${f1(c.pctB)}`
            : "";
        const notes = [...(c.flags ?? [])];
        if (k === "loadNoGc" && c.gc)
          notes.push(
            `${c.gc.allocMB.toFixed(1)} MB allocated during load (ref ${c.gcRef.allocMB.toFixed(1)} MB); GC pause inside in ${c.gc.pauseRounds}/${c.gc.n} rounds (ref ${c.gcRef.pauseRounds}/${c.gcRef.n})`,
          );
        const pctText =
          c.outcome === NO_OUTCOME_TINY
            ? absDiff(c)
            : c.pct != null
              ? `${f1(c.pct)} ${fci(c.ci)}`
              : "—";
        P(
          `| ${short(r)} | ${label} | ${fmtN(c.mean, "ms")} (${fmtN(c.median, "ms")}) | ${c.refMean != null ? `${fmtN(c.refMean, "ms")} (${fmtN(c.refMedian, "ms")}), ${name(c.ref)}` : "—"} | ${pctText} | ${vs} | ${ab} | ${word(c.outcome)}${c.qualifier ? ` ${c.qualifier}` : ""} | ${notes.join("; ")} |`,
        );
      }
    P();
    if (rows.some((r) => S.cells[r]?.loadNoGc?.[lib]?.gc)) {
      P(`#### ${name(lib)}: GC diagnostics (separate FAIR_GC=1 pass)`);
      P();
      P(
        "Library / its reference. Diagnostics only: subtracting pauses or charging GC by bytes never changes an outcome.",
      );
      P();
      P(
        "| Row | Window | Rounds with a GC pause inside | Mean pause inside | Mean without the observed pause | MB allocated in the window | Note |",
      );
      P("|---|---|---|---|---|---|---|");
      for (const r of rows)
        for (const [k, label] of TIMED) {
          const c = S.cells[r]?.[k]?.[lib];
          if (!c?.gc) continue;
          const g = c.gc,
            h = c.gcRef;
          const note = [
            g.busy ? "from a busy run" : "",
            c.gcPlacement ? "size sensitive to GC placement" : "",
            k === "loadNoGc" &&
            c.flags?.includes("higher allocation during load")
              ? "higher allocation during load"
              : "",
          ]
            .filter(Boolean)
            .join("; ");
          P(
            `| ${short(r)} | ${label} | ${g.pauseRounds}/${g.n} / ${h.pauseRounds}/${h.n} | ${g.pauseMean.toFixed(3)} / ${h.pauseMean.toFixed(3)} ms | ${fmtN(g.noPauseMean, "ms")} / ${fmtN(h.noPauseMean, "ms")} | ${g.allocMB.toFixed(2)} / ${h.allocMB.toFixed(2)} | ${note} |`,
          );
        }
      P();
    }
  }
  P("### Reference: mean (median) of the better Yjs in each cell");
  P();
  P(
    "| Row | bytes/update | stored doc (gzip) | stored doc (uncompressed) | load | load, Kevin | memory | time | save |",
  );
  P("|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const c = (k: string) => {
      const entry = Object.entries<any>(S.cells[r]?.[k] ?? {}).find(
        ([, x]) => x.outcome === "reference",
      );
      return entry
        ? `${fmtN(entry[1].mean, units[k]!)} (${fmtN(entry[1].median, units[k]!)}, ${name(entry[0])})`
        : "—";
    };
    P(
      `| ${short(r)} | ${c("bytes")} | ${c("doc")} | ${c("docRaw")} | ${c("loadNoGc")} | ${c("loadKevin")} | ${c("mem")} | ${c("time")} | ${c("save")} |`,
    );
  }
  P();

  const anyH2 = rows.some((r) => libs.some((l) => S.cells[r]?.save?.[l]?.h2));
  if (anyH2) {
    const h2Rounds = S.meta.runs.kevin?.h2A?.rounds;
    P("## Second heap history (16 MB of short-lived garbage at process start)");
    P();
    P(
      `Same rows, same libraries, ${h2Rounds} + ${h2Rounds} rounds. Cross-history: **robust across the histories tested** only when both give the same decided outcome; otherwise inconclusive.`,
    );
    P();
    P(
      "| Library | Row | Column | Official history | Second history | Cross-history |",
    );
    P("|---|---|---|---|---|---|");
    for (const lib of libs)
      for (const r of rows)
        for (const [k, label] of TIMED) {
          const c = S.cells[r]?.[k]?.[lib];
          if (!c?.h2) continue;
          const h = c.h2;
          P(
            `| ${name(lib)} | ${short(r)} | ${label} | ${c.pct != null ? `${f1(c.pct)} ${fci(c.ci)} ` : ""}${word(c.outcome)} | ${h.pct != null ? `${f1(h.pct)} ${fci(h.ci)} ` : ""}${word(h.outcome)} | ${c.cross ?? "—"} |`,
          );
        }
    P();
  }
  const anyConfirm = rows.some((r) =>
    libs.some((l) => TIMED.some(([k]) => S.cells[r]?.[k]?.[l]?.confirm)),
  );
  if (anyConfirm) {
    const cr = S.meta.confirm?.rounds;
    P(
      `## Confirmation run of the named cells (${cr} + ${cr} rounds, decides on its own)`,
    );
    P();
    P(
      "97.5 % intervals (with two Yjs: 98.75 % each). Both results are shown; the confirmation decides the cell.",
    );
    P();
    P("| Library | Row | Column | Official run | Confirmation run |");
    P("|---|---|---|---|---|");
    for (const lib of libs)
      for (const r of rows)
        for (const [k, label] of TIMED) {
          const c = S.cells[r]?.[k]?.[lib];
          if (!c?.confirm) continue;
          const x = c.confirm;
          P(
            `| ${name(lib)} | ${short(r)} | ${label} | ${c.pct != null ? `${f1(c.pct)} ${fci(c.ci)} ` : ""}${word(c.outcome)} | ${x.pct != null ? `${f1(x.pct)} ${fci(x.ci)} ` : ""}${word(x.outcome)}${x.flags?.length ? ` ⚑ ${x.flags.join(", ")}` : ""} |`,
          );
        }
    P();
  }
}

if (D) {
  P("## App-shaped documents");
  P();
  P(
    "A fresh process per measurement. `explorer` = file-explorer tree (~2,000 nodes); `lexical` = docnode-lexical-shaped document (~10,000 nodes). Yjs: the same shapes with `XmlElement` (13) / `Node` (14); Yjs has no toJSON / fromJSON, so save = `encodeStateAsUpdateV2` and load = `applyUpdateV2`. Mean, % [interval] and outcome as above.",
  );
  P();
  const ucols = [
    ["save", "save", "ms"],
    ["load", "load", "ms"],
    ["toJSON", "toJSON", "ms"],
    ["fromJSON", "fromJSON", "ms"],
    ["gzip", "gzip", "B"],
    ["raw", "raw", "B"],
    ["memWarm", "memory (2nd load)", "B"],
  ];
  for (const kind of Object.keys(D.cells)) {
    P(`### ${kind}`);
    P();
    P(`| Library | ${ucols.map((c) => c[1]).join(" | ")} |`);
    P(`|${"---|".repeat(ucols.length + 1)}`);
    const dlibs = Object.keys(D.cells[kind]?.save ?? {});
    for (const lib of dlibs) {
      const row = ucols.map(([k, , u]) => {
        const c = D.cells[kind]?.[k!]?.[lib];
        if (!c) return "—";
        const v = fmtN(c.mean, u!);
        return c.outcome === "reference"
          ? `${v} (ref)`
          : c.outcome === NO_OUTCOME_TINY
            ? `${v} (${absDiff(c)})`
            : c.pct === null || c.pct === undefined
              ? v
              : `${v} (${f1(c.pct)} ${fci(c.ci)} ${word(c.outcome)}${c.flags?.length ? ` ⚑ ${c.flags.join(", ")}` : ""})`;
      });
      P(`| ${name(lib)} | ${row.join(" | ")} |`);
    }
    P();
  }
}

if (I) {
  P(`## ${I.new} against ${I.base}: time and instructions`);
  P();
  P(
    `% of ${I.new} against ${I.base} (ratio of means, negative = ${I.new} is better). **Better / worse only if time and instructions point the same way.**`,
  );
  P();
  P("| Row | Column | Time | Instructions | Judgement |");
  P("|---|---|---|---|---|");
  for (const [row, cols] of Object.entries<any>(I.kevin))
    for (const [col, v] of Object.entries<any>(cols))
      P(
        `| ${row.replace(/^\[(\w+\.\d+)\] /, "$1 ")} | ${col} | ${cell(v.time)} | ${cell(v.ins)} | ${v.judgement} |`,
      );
  for (const [kind, cols] of Object.entries<any>(I.docs))
    for (const [col, v] of Object.entries<any>(cols))
      P(
        `| doc ${kind} | ${col} | ${cell(v.time)} | ${cell(v.ins)} | ${v.judgement} |`,
      );
  P();
}

P("## Machine load per run (1-minute load average, read before each process)");
P();
P(
  "| Run | Rounds | Load min / median / max | Processes with load > 6 | Valid (≤ 25 %)? |",
);
P("|---|---|---|---|---|");
for (const file of readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const r = J(`${DIR}/${file}`);
  const l = r?.meta?.loadSummary;
  if (!l) continue;
  P(
    `| ${file.replace(/\.json$/, "")} | ${r.meta.rounds} | ${l.min.toFixed(1)} / ${l.median.toFixed(1)} / ${l.max.toFixed(1)} | ${(l.fractionAbove6 * 100).toFixed(0)} % | ${l.fractionAbove6 <= 0.25 ? "yes" : "**no: no verdict (busy machine)**"} |`,
  );
}
P();
if (WALL?.phases) {
  P("## Wall time");
  P();
  P("| Phase | Minutes | Started |");
  P("|---|---|---|");
  let totalMin = 0;
  for (const [ph, v] of Object.entries<any>(WALL.phases)) {
    totalMin += v.minutes;
    P(`| ${ph} | ${v.minutes.toFixed(1)} | ${v.started} |`);
  }
  P(`| **Total** | **${totalMin.toFixed(1)}** | |`);
  P();
}
writeFileSync(`${DIR}/report.md`, lines.join("\n") + "\n");
console.log("report written:", `${DIR}/report.md`);
