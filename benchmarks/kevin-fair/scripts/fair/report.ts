// Writes <dir>/report.md from the summaries (fair-summary.json, and if present fair-docs-summary.json and
// fair-ic-summary.json). Tables only; the reading of the numbers is up to the person who ran it.
// usage: node report.ts <dir>
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
const DIR = process.argv[2]!;
const J = (f: string) =>
  existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
const S = J(`${DIR}/fair-summary.json`),
  D = J(`${DIR}/fair-docs-summary.json`),
  I = J(`${DIR}/fair-ic-summary.json`);
const YJS = new Set(["yjs13", "yjs14", "yjs13xml", "yjs14node"]);
const NAMES: Record<string, string> = {
  yjs13: "Yjs 13",
  yjs14: "Yjs 14",
  yjs13xml: "Yjs 13 (XmlElement)",
  yjs14node: "Yjs 14 (Node)",
};
const name = (lib: string) => NAMES[lib] ?? lib;
const ICON: Record<string, string> = {
  win: "🟢 win",
  loss: "🔴 loss",
  tie: "⚪ tie",
  "tie (unstable)": "🟡 tie (unstable)",
  reference: "ref",
  "no %": "—",
};
const f1 = (p: number) =>
  `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p) < 10 ? Math.abs(p).toFixed(1) : Math.abs(p).toFixed(0)} %`;
const cell = (c: any, withVerdict = true) =>
  !c
    ? "—"
    : c.verdict === "reference"
      ? "ref"
      : c.pct === null || c.pct === undefined
        ? "—"
        : withVerdict
          ? `${f1(c.pct)} ${ICON[c.verdict] ?? c.verdict}`
          : f1(c.pct);
const fmtN = (v: number, unit: string) =>
  unit === "ms"
    ? `${v < 1 ? v.toFixed(3) : v.toFixed(2)} ms`
    : v >= 1e6
      ? `${(v / 1e6).toFixed(2)} MB`
      : v >= 1e3
        ? `${(v / 1e3).toFixed(1)} kB`
        : `${v.toFixed(0)} B`;
const lines: string[] = [];
const P = (s = "") => lines.push(s);

P("# Fair Kevin benchmark");
P();
P(
  `Node ${S?.meta?.runs?.kevin?.A?.node ?? "?"}. % = against the best Yjs of the same cell (13 or 14, the lowest median over all rounds of A and B). **Negative = better than Yjs.** Verdict: 🟢 win (the whole 95 % interval below −2 %), 🔴 loss (whole interval above +2 %), ⚪ tie; green or red only if runs A and B agree, else 🟡 tie (unstable).`,
);
P();

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
      .replace("20√N clients concurrently ", "20√N ");
  const libs = (S.sets.kevin.libs as string[]).filter((l) => !YJS.has(l));
  const main = ["loadNoGc", "mem", "time", "save", "bytes", "doc", "docRaw"];
  P("## Cells won, lost or tied per library");
  P();
  P(
    "Cells = rows × columns with a verdict (bytes, stored doc gzip and uncompressed, load without forced GC, memory, time, save). G1.8 and G1.9 included.",
  );
  P();
  P("| Library | 🟢 win | 🔴 loss | ⚪ tie | 🟡 unstable | no % |");
  P("|---|---|---|---|---|---|");
  for (const lib of libs) {
    const n: Record<string, number> = {};
    for (const r of rows)
      for (const c of main) {
        const v = S.cells[r]?.[c]?.[lib]?.verdict;
        if (v) n[v] = (n[v] ?? 0) + 1;
      }
    P(
      `| ${name(lib)} | ${n.win ?? 0} | ${n.loss ?? 0} | ${n.tie ?? 0} | ${n["tie (unstable)"] ?? 0} | ${n["no %"] ?? 0} |`,
    );
  }
  P();
  P("## One table per library");
  P();
  P(
    "Columns: **bytes/update** = uncompressed, as DocSync sends them; **stored doc** = the saved document, with gzip and uncompressed; **load** = the inner window `load + check` without the harness's forced GC (the verdict column); **load, Kevin** = upstream `parseTime` (includes 2 full forced GCs), shown as % only; **memory** = `memFairWarm`; **time** = the whole row; **save** = `encodeTime`.",
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
  }
  P("### Reference: median of the best Yjs in each cell");
  P();
  P(
    "| Row | bytes/update | stored doc (gzip) | stored doc (uncompressed) | load | load, Kevin | memory | time | save |",
  );
  P("|---|---|---|---|---|---|---|---|---|");
  const units: Record<string, string> = Object.fromEntries(
    S.cols.map((c: any) => [c.key, c.unit]),
  );
  for (const r of rows) {
    const c = (k: string) => {
      const entry = Object.entries<any>(S.cells[r]?.[k] ?? {}).find(
        ([, x]) => x.verdict === "reference",
      );
      return entry
        ? `${fmtN(entry[1].median, units[k]!)} (${name(entry[0])})`
        : "—";
    };
    P(
      `| ${short(r)} | ${c("bytes")} | ${c("doc")} | ${c("docRaw")} | ${c("loadNoGc")} | ${c("loadKevin")} | ${c("mem")} | ${c("time")} | ${c("save")} |`,
    );
  }
  P();
}

if (D) {
  P("## App-shaped documents");
  P();
  P(
    "A fresh process per measurement. `explorer` = file-explorer tree (~2,000 nodes); `lexical` = docnode-lexical-shaped document (~10,000 nodes). Yjs: the same shapes with `XmlElement` (13) / `Node` (14); Yjs has no toJSON / fromJSON, so save = `encodeStateAsUpdateV2` and load = `applyUpdateV2`.",
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
        const v = fmtN(c.median, u!);
        return c.verdict === "reference"
          ? `${v} (ref)`
          : c.pct === null || c.pct === undefined
            ? v
            : `${v} (${f1(c.pct)} ${ICON[c.verdict] ?? ""})`;
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
    `% of ${I.new} against ${I.base} (negative = ${I.new} is better). **Better / worse only if time and instructions point the same way.**`,
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
  "| Run | Rounds | Load min / median / max | Processes with load > 6 | Passes the rule (≤ 25 %)? |",
);
P("|---|---|---|---|---|");
for (const file of readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const r = J(`${DIR}/${file}`);
  const l = r?.meta?.loadSummary;
  if (!l) continue;
  P(
    `| ${file.replace(/\.json$/, "")} | ${r.meta.rounds} | ${l.min.toFixed(1)} / ${l.median.toFixed(1)} / ${l.max.toFixed(1)} | ${(l.fractionAbove6 * 100).toFixed(0)} % | ${l.fractionAbove6 <= 0.25 ? "yes" : "**no**"} |`,
  );
}
P();
writeFileSync(`${DIR}/report.md`, lines.join("\n") + "\n");
console.log("report written:", `${DIR}/report.md`);
