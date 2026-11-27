// App-shaped documents probe runner (Lexical-shaped and file-explorer-shaped docs), same shape as run.ts: one fresh process per
// measurement, rounds interleave the libraries and alternate their order, one process at a time. The doc is made again
// every round (random node ids, so the sizes can change a little).
// env: W (work folder, default: benchmarks/kevin-fair), OUT, SUBJECTS (required: yjs13, yjs14 and DocNode trees in
//      $W/trees/<name>), KINDS (explorer,lexical), ROUNDS (15),
//      FAIR_IC (0/1: instructions, DocNode libraries only), REBUILD (1 = rebuild the probe bundles)
// Exit code 3 = repeat (load average > 6 in more than a quarter of the processes).
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const W =
  process.env.W ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT = process.env.OUT!,
  ROUNDS = Number(process.env.ROUNDS ?? 15);
const SUBJECTS = process.env.SUBJECTS!.split(","),
  KINDS = (process.env.KINDS ?? "explorer,lexical").split(",");
const DATA = `${W}/tmp/docs-data`;
mkdirSync(DATA, { recursive: true });
const node = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(
    process.execPath,
    ["--expose-gc", "--max-old-space-size=2048", ...args],
    { env: { ...process.env, W, ...env }, stdio: "ignore", timeout: 300_000 },
  );
const isYjs = (s: string) => s === "yjs13" || s === "yjs14";
for (const s of SUBJECTS)
  if (!isYjs(s)) {
    const bundle = `${W}/bundles/docs-${s}.mjs`;
    if (!existsSync(bundle) || process.env.REBUILD)
      spawnSync(
        process.execPath,
        [`${W}/scripts/fair/build-docs.ts`, `${W}/trees/${s}`, bundle],
        { stdio: "inherit" },
      );
  }
const make = (s: string, k: string, f: string) =>
  isYjs(s)
    ? node([`${W}/scripts/fair/docs-yjs.ts`, "make", s, k, f])
    : node([`${W}/bundles/docs-${s}.mjs`, "make", k, f]);
const measure = (s: string, k: string, f: string, o: string) =>
  isYjs(s)
    ? node([`${W}/scripts/fair/docs-yjs.ts`, "measure", s, k, f, o])
    : node([`${W}/bundles/docs-${s}.mjs`, "measure", k, f, o], {
        FAIR_IC: process.env.FAIR_IC ?? "0",
      });
const acc: any = {
  meta: {
    node: process.version,
    rounds: ROUNDS,
    subjects: SUBJECTS,
    kinds: KINDS,
    fairIc: process.env.FAIR_IC === "1",
    started: new Date().toISOString(),
    loads: [] as unknown[],
  },
  timing: {},
};
for (let r = 0; r < ROUNDS; r++) {
  const order = r % 2 ? [...SUBJECTS].reverse() : SUBJECTS;
  for (const k of KINDS)
    for (const s of order) {
      const f = `${DATA}/${s}-${k}.json`,
        o = `${DATA}/m-${process.pid}.json`;
      writeFileSync(o, "{}");
      make(s, k, f);
      const l0 = loadavg()[0];
      measure(s, k, f, o);
      let res: any;
      try {
        res = JSON.parse(readFileSync(o, "utf8"));
      } catch {
        res = {};
      }
      acc.meta.loads.push({
        round: r,
        s,
        kind: k,
        load1min: l0,
        ok: res.load !== undefined,
      });
      if (res.load === undefined) {
        console.error("no result", s, k);
        continue;
      }
      ((acc.timing[k] ??= {})[s] ??= {
        status: "ok",
        samples: [],
      }).samples.push({ round: r, load1min: l0, raw: res });
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
