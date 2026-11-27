// The official local runner. One process per library and round, all rows in that process, same rows and order for every
// library, rounds interleave the libraries and alternate their order, one process at a time.
// env: W (work folder, default: benchmarks/kevin-fair), OUT, SUBJECTS (comma list), ROWS (comma list of row prefixes), ROUNDS (30), MODE (time | extra),
//      HARNESS (fair), FAIR_IC (0/1), LABEL (free text saved in meta).
// Exit code 3 = "repeat this run": the machine was busy (load average > 6 in more than a quarter of the processes).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const env = (k: string) => process.env[k]!;
const W =
  process.env.W ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = env("OUT"),
  ROUNDS = Number(process.env.ROUNDS ?? 30),
  MODE = process.env.MODE ?? "time";
const SUBJECTS = env("SUBJECTS").split(","),
  ROWS = env("ROWS");
mkdirSync(`${W}/tmp`, { recursive: true });
const tmp = `${W}/tmp/fair-child-${process.pid}.json`;
const acc: any = {
  meta: {
    label: process.env.LABEL ?? "",
    mode: MODE,
    node: process.version,
    rounds: ROUNDS,
    subjects: SUBJECTS,
    rows: ROWS.split(","),
    harness: process.env.HARNESS ?? "fair",
    fairIc: process.env.FAIR_IC === "1",
    flags: [
      "--expose-gc",
      "--max-old-space-size=2048",
      ...(process.env.EXTRA_FLAGS ? process.env.EXTRA_FLAGS.split(" ") : []),
    ],
    started: new Date().toISOString(),
    loads: [] as unknown[],
  },
  timing: {},
};
for (let r = 0; r < ROUNDS; r++) {
  const order = r % 2 ? [...SUBJECTS].reverse() : SUBJECTS;
  for (const s of order) {
    writeFileSync(tmp, "{}");
    // The extra (bytes) pass needs one process per row: its counters are per document.
    const rowList = MODE === "extra" ? ROWS.split(",") : [ROWS];
    for (const rowArg of rowList) {
      const l0 = loadavg()[0];
      spawnSync(
        process.execPath,
        [
          "--expose-gc",
          "--max-old-space-size=2048",
          ...(process.env.EXTRA_FLAGS
            ? process.env.EXTRA_FLAGS.split(" ")
            : []),
          `${W}/scripts/fair/child.ts`,
          MODE,
          s,
          rowArg,
          tmp,
        ],
        { env: { ...process.env, W }, stdio: "ignore", timeout: 900_000 },
      );
      let res: any;
      try {
        res = JSON.parse(readFileSync(tmp, "utf8"));
      } catch {
        res = { status: "error", message: "no output" };
      }
      acc.meta.loads.push({
        round: r,
        s,
        row: MODE === "extra" ? rowArg : undefined,
        load1min: l0,
        load1minAfter: loadavg()[0],
        status: res.status,
        message: res.message,
      });
      if (res.status !== "ok") {
        console.error(s, rowArg, res.message);
        continue;
      }
      if (MODE === "extra") {
        const row = rowArg as string;
        ((acc.timing[row] ??= {})[s] ??= {
          status: "ok",
          samples: [],
        }).samples.push({ round: r, load1min: l0, raw: res.extra });
        continue;
      }
      const rows = new Set(
        Object.keys(res.results)
          .filter((k) => k.endsWith("(time)"))
          .map((k) => k.slice(0, k.lastIndexOf(" ("))),
      );
      for (const row of rows) {
        const raw: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(res.results))
          if (k.startsWith(row + " (")) raw[k] = v;
        ((acc.timing[row] ??= {})[s] ??= {
          status: "ok",
          samples: [],
        }).samples.push({ round: r, load1min: l0, raw });
      }
    }
  }
  writeFileSync(OUT, JSON.stringify(acc));
  if (r % 5 === 4 || r === ROUNDS - 1)
    console.log(
      new Date().toISOString(),
      "round",
      r + 1,
      "/",
      ROUNDS,
      "load",
      loadavg()[0].toFixed(1),
    );
}
const ls = (acc.meta.loads as { load1min: number }[]).map((l) => l.load1min);
acc.meta.ended = new Date().toISOString();
acc.meta.loadSummary = {
  min: Math.min(...ls),
  max: Math.max(...ls),
  median: [...ls].sort((a, b) => a - b)[Math.floor(ls.length / 2)],
  fractionAbove6: ls.filter((x) => x > 6).length / ls.length,
};
acc.meta.repeat = acc.meta.loadSummary.fractionAbove6 > 0.25;
writeFileSync(OUT, JSON.stringify(acc));
console.log(
  acc.meta.repeat
    ? "REPEAT (load > 6 in more than a quarter of the processes)"
    : "ALL DONE",
  JSON.stringify(acc.meta.loadSummary),
);
process.exit(acc.meta.repeat ? 3 : 0);
