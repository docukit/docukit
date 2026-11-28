// Quick table: DocNode versions against the better of Yjs 13 and Yjs 14, in minutes. The default for the artifact's
// tables while a milestone is open; the full method (all.ts) is for when the owner asks and to close a milestone.
//
//  - Two groups, because every subject of a process must run the same rows (they share one seeded random generator,
//    and the harness stops at the first row a subject cannot run): text rows (B1.1-B1.7, B2.1-B2.4, B3.5, B4) with the
//    versions that have `text()`, and tree rows (B1.8-B1.11, B3.1-B3.4) with every version. Yjs runs in both.
//  - Timed cells (load without forced GC, memory, time, save): paired rounds as in quick-compare.ts, no waiting for a
//    quiet machine, looks at 6 and 12 rounds with 99 % intervals; a row leaves when all its cells are decided. Against
//    "the better Yjs": the larger of the two ratios, with the interval [max of the lower ends, max of the upper ends].
//  - Exact cells (bytes per update, stored doc gzip and uncompressed): one pass (MODE=extra, no warm-up).
//  - Yjs cache: Yjs does not change between runs, and Yjs 14 in B4 is most of the time (~9 s per pass). A run that
//    measures Yjs stores its samples in out/yjs-cache.json, keyed by the rows, the harness files, the Yjs versions,
//    Node and the warm-up; later runs reuse them and run only DocNode. Those comparisons are not paired (Welch's
//    interval), so load that differs between the runs moves them; the table says the cache's date. `--fresh-yjs`
//    measures Yjs again (do it for numbers that close a milestone, or when the machine's load changed a lot).
//
// usage: node scripts/fair/quick-table.ts <name>=<ref> [<name>=<ref> ...] [--rows "[B4],[B1.1]"] [--fresh-yjs]
//   example: node scripts/fair/quick-table.ts antes=origin/main despues=docnode/m2-4-text-move
// Writes OUT_DIR (default out/quick-table/<date>)/summary.json and table.html (the artifact's table, one per version,
// with an "updated" note per row), and adds every cell to out/measured.json.
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { med } from "./stats.ts";
import {
  W,
  bundle,
  hasText,
  log,
  outcomeOf,
  paired,
  runRounds,
  treeOf,
  valuesOf,
  TINY_MS,
  unpaired,
  type Sample,
  type Store,
} from "./quick.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args.splice(at, 2)[1];
};
const rowsFlag = flag("--rows")?.split(",");
const freshAt = args.indexOf("--fresh-yjs");
const fresh = freshAt >= 0;
if (fresh) args.splice(freshAt, 1);
const versions = args.map((a) => {
  const at = a.indexOf("=");
  if (at < 1)
    throw new Error(
      'usage: node scripts/fair/quick-table.ts <name>=<ref> [...] [--rows "[B4],[B1.1]"]',
    );
  return { name: a.slice(0, at), tree: treeOf(a.slice(at + 1)) };
});
if (versions.length === 0) throw new Error("give at least one <name>=<ref>");

const YJS = ["yjs13", "yjs14"];
const TEXT_ROWS = [
  "[B4]",
  "[B1.1]",
  "[B1.2]",
  "[B1.3]",
  "[B1.4]",
  "[B1.5]",
  "[B1.6]",
  "[B1.7]",
  "[B2.1]",
  "[B2.2]",
  "[B2.3]",
  "[B2.4]",
  "[B3.5]",
];
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
const want = (r: string) => !rowsFlag || rowsFlag.includes(r);
/** Timed columns: name, key of the sample. */
const TIMED = [
  ["load", "loadNoGc exact"],
  ["mem", "memFair"],
  ["time", "time exact"],
  ["save", "encodeTime exact"],
] as const;
const EXACT = ["bytes", "docGzip", "docRaw"] as const;
const LOOKS = [
  { rounds: 6, level: 0.99 },
  { rounds: 12, level: 0.99 },
];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const DIR = resolve(process.env.OUT_DIR ?? `${W}/out/quick-table/${stamp}`);
mkdirSync(DIR, { recursive: true });
for (const v of versions) bundle(`qt-${v.name}`, v.tree);
const lib = (name: string) => `qt-${name}`;

const groups = [
  {
    id: "text",
    rows: TEXT_ROWS.filter(want),
    versions: versions.filter((v) => hasText(v.tree)),
  },
  { id: "tree", rows: TREE_ROWS.filter(want), versions },
].filter((g) => g.rows.length > 0 && g.versions.length > 0);

/** What makes Yjs samples reusable: the harness, the Yjs factories and versions, Node, the warm-up. */
const fingerprint = (() => {
  const hash = createHash("sha1");
  const lib = `${W}/cb/js-lib-fair`;
  for (const f of readdirSync(lib).sort())
    if (f.endsWith(".js") && f !== "b4-editing-trace.js")
      hash.update(readFileSync(`${lib}/${f}`));
  for (const f of [
    "cb/benchmarks/yjs/factory.js",
    "cb/benchmarks/yjs14/factory.js",
    "cb/node_modules/yjs/package.json",
    "cb/benchmarks/yjs14/node_modules/yjs/package.json",
  ])
    if (existsSync(`${W}/${f}`)) hash.update(readFileSync(`${W}/${f}`));
  hash.update(`${process.version} warm ${process.env.FAIR_WARM ?? "2"}`);
  return hash.digest("hex").slice(0, 12);
})();
type CacheEntry = {
  date: string;
  loadMedian: number;
  samples: Record<string, Record<string, Sample[]>>;
  extra: Record<string, Record<string, Record<string, unknown>>>;
};
const CACHE_FILE = `${W}/out/yjs-cache.json`;
const cache: Record<string, CacheEntry> = existsSync(CACHE_FILE)
  ? JSON.parse(readFileSync(CACHE_FILE, "utf8"))
  : {};
const cacheKey = (group: string, rows: string[]) =>
  `${fingerprint} ${group} ${rows.join(",")}`;
/** The cached Yjs entries this run used, for the table's note. */
const usedCache: CacheEntry[] = [];

type Cell = {
  outcome: string;
  pct: number;
  ci?: [number, number];
  rounds?: number;
  spread?: number;
  values: Record<string, number>;
};
/** row -> column -> version -> cell */
const cells: Record<string, Record<string, Record<string, Cell>>> = {};
const loads: number[] = [];

/** One timed cell of a version against the better Yjs. */
function timedCell(
  store: Store,
  yjsStore: Store | undefined,
  row: string,
  key: string,
  version: string,
  level: number,
): Cell | undefined {
  const mine = valuesOf(store, row, lib(version), key);
  const against = (y: string) =>
    yjsStore
      ? unpaired(mine, valuesOf(yjsStore, row, y, key), level)
      : paired(mine, valuesOf(store, row, y, key), level);
  const a = against("yjs13"),
    b = against("yjs14");
  if (!a || !b) return undefined;
  const values = { docnode: a.libMean, yjs13: a.refMean, yjs14: b.refMean };
  const pct = Math.max(a.pct, b.pct);
  const ci: [number, number] = [
    Math.max(a.ci[0], b.ci[0]),
    Math.max(a.ci[1], b.ci[1]),
  ];
  const tiny =
    key !== "memFair" &&
    values.docnode < TINY_MS &&
    Math.min(values.yjs13, values.yjs14) < TINY_MS;
  return {
    outcome: tiny ? "tiny" : outcomeOf(ci),
    pct,
    ci,
    rounds: Math.min(a.rounds, b.rounds),
    spread: Math.max(a.spread, b.spread),
    values,
  };
}

for (const g of groups) {
  const key = cacheKey(g.id, g.rows);
  const cached = fresh ? undefined : cache[key];
  let yjsStore: Store | undefined;
  if (cached) {
    usedCache.push(cached);
    yjsStore = new Map();
    for (const [row, byLib] of Object.entries(cached.samples))
      yjsStore.set(row, new Map(Object.entries(byLib)));
    log(`${g.id}: Yjs from the cache of ${cached.date}`);
  }
  const subjects = [
    ...(cached ? [] : YJS),
    ...g.versions.map((v) => lib(v.name)),
  ];
  const store: Store = new Map();
  const groupLoads: number[] = [];
  let active = [...g.rows];
  let done = 0;
  for (const look of LOOKS) {
    log(`${g.id}: rounds ${done + 1}-${look.rounds}: ${active.join(",")}`);
    const seen = runRounds(
      `${DIR}/${g.id}-${look.rounds}.json`,
      subjects,
      active,
      look.rounds - done,
      store,
      done,
    );
    loads.push(...seen);
    groupLoads.push(...seen);
    done = look.rounds;
    for (const row of active)
      for (const [col, key] of TIMED)
        for (const v of g.versions) {
          const c = timedCell(store, yjsStore, row, key, v.name, look.level);
          if (c) ((cells[row] ??= {})[col] ??= {})[v.name] = c;
        }
    active = active.filter((row) =>
      TIMED.some(([col]) =>
        g.versions.some((v) => {
          const o = cells[row]?.[col]?.[v.name]?.outcome;
          return !o || o === "inconclusive";
        }),
      ),
    );
    if (active.length === 0) break;
  }
  // Exact cells: one pass, one process per row.
  log(`${g.id}: bytes and stored doc`);
  const extra: Store = new Map();
  runRounds(`${DIR}/${g.id}-extra.json`, subjects, g.rows, 1, extra, 0, {
    MODE: "extra",
    FAIR_WARM: "0",
  });
  if (!cached) {
    const entry: CacheEntry = {
      date: new Date().toISOString(),
      loadMedian: groupLoads.length ? med(groupLoads) : 0,
      samples: {},
      extra: {},
    };
    for (const row of g.rows)
      for (const y of YJS) {
        const list = store.get(row)?.get(y);
        if (list) (entry.samples[row] ??= {})[y] = list;
        const raw = extra.get(row)?.get(y)?.[0]?.raw;
        if (raw) (entry.extra[row] ??= {})[y] = raw;
      }
    cache[key] = entry;
    writeFileSync(CACHE_FILE, JSON.stringify(cache));
  }
  for (const row of g.rows) {
    const get = (l: string) =>
      cached && YJS.includes(l)
        ? cached.extra[row]?.[l]
        : extra.get(row)?.get(l)?.[0]?.raw;
    const y13 = get("yjs13"),
      y14 = get("yjs14");
    if (!y13 || !y14) continue;
    for (const v of g.versions) {
      const m = get(lib(v.name));
      if (!m) continue;
      const of = (raw: Record<string, unknown>, col: string) =>
        col === "bytes"
          ? Number(raw.updates)
            ? Number(raw.bytes) / Number(raw.updates)
            : NaN
          : Number(raw[col]);
      for (const col of EXACT) {
        const values = {
          docnode: of(m, col),
          yjs13: of(y13, col),
          yjs14: of(y14, col),
        };
        if (!Number.isFinite(values.docnode)) continue;
        const best = Math.min(values.yjs13, values.yjs14);
        const pct = (values.docnode / best - 1) * 100;
        ((cells[row] ??= {})[col] ??= {})[v.name] = {
          outcome: outcomeOf([pct, pct]),
          pct,
          values,
        };
      }
    }
  }
}

const date = new Date().toISOString();
const loadMedian = loads.length ? med(loads) : 0;
const maxLoad = loads.length ? Math.max(...loads) : 0;
const summary = {
  mode: "quick-table",
  date,
  versions: versions.map((v) => ({
    name: v.name,
    ref: v.tree.label,
    commit: v.tree.commit,
    text: hasText(v.tree),
  })),
  looks: LOOKS,
  load: { median: loadMedian, max: maxLoad },
  cells,
};
writeFileSync(`${DIR}/summary.json`, JSON.stringify(summary, null, 2));

const ledgerFile = `${W}/out/measured.json`;
const ledger = existsSync(ledgerFile)
  ? JSON.parse(readFileSync(ledgerFile, "utf8"))
  : {};
for (const [row, byCol] of Object.entries(cells))
  for (const [col, byVersion] of Object.entries(byCol))
    for (const [version, c] of Object.entries(byVersion))
      ((ledger.table ??= {})[`${version} ${row}`] ??= {})[col] = {
        date,
        mode: "quick-table",
        commit: versions.find((v) => v.name === version)!.tree.commit,
        ...c,
        loadMedian,
      };
writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));

// ------------------------------------------------------------------ the artifact's table
const ROW_TEXT: Record<string, [string, "hi" | "mid" | "lo"]> = {
  "[B4]": ["editar un paper real (260.000 ediciones)", "hi"],
  "[B1.1]": ["tipear al final", "mid"],
  "[B1.2]": ["pegar un texto", "mid"],
  "[B1.3]": ["tipear al revés", "lo"],
  "[B1.4]": ["letras al azar", "mid"],
  "[B1.5]": ["palabras al azar", "mid"],
  "[B1.6]": ["pegar y borrar todo", "mid"],
  "[B1.7]": ["insertar y borrar al azar", "mid"],
  "[B2.1]": ["dos escriben a la vez al principio", "lo"],
  "[B2.2]": ["dos escriben letras al azar", "mid"],
  "[B2.3]": ["dos escriben palabras al azar", "mid"],
  "[B2.4]": ["dos insertan y borran", "mid"],
  "[B3.5]": ["465 escriben texto a la vez", "mid"],
  "[B1.8]": ["agregar números al final", "lo"],
  "[B1.9]": ["pegar una lista", "lo"],
  "[B1.10]": ["agregar números al principio", "lo"],
  "[B1.11]": ["números al azar", "lo"],
  "[B3.1]": ["465 escriben un número", "lo"],
  "[B3.2]": ["465 escriben un objeto", "lo"],
  "[B3.3]": ["465 escriben un string", "lo"],
  "[B3.4]": ["465 insertan en lista", "lo"],
};
const COLUMNS: [string, string, "hi" | "mid" | "lo"][] = [
  ["bytes", "bytes por update<br><small>sin comprimir</small>", "hi"],
  ["docGzip", "documento<br><small>gzip</small>", "hi"],
  ["docRaw", "documento<br><small>sin comprimir</small>", "hi"],
  ["load", "cargar<br><small>sin GC forzado</small>", "hi"],
  ["mem", "memoria", "mid"],
  ["time", "tiempo", "mid"],
  ["save", "guardar", "lo"],
];
const RANK = { hi: 2, mid: 1, lo: 0 };
const PILL = { hi: "alta", mid: "media", lo: "baja" };
const es = (n: number, d: number) =>
  n.toLocaleString("es-AR", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
const sgnPct = (p: number) =>
  `${p > 0.05 ? "+" : p < -0.05 ? "−" : ""}${es(Math.abs(p), Math.abs(p) < 10 ? 1 : 0)} %`;
const unit = (col: string, v: number) => {
  if (col === "bytes") return `${es(v, 1)} B`;
  if (col === "docGzip" || col === "docRaw")
    return v >= 1000 ? `${es(v / 1000, 1)} KB` : `${es(v, 0)} B`;
  if (col === "mem")
    return v >= 1e6 ? `${es(v / 1e6, 2)} MB` : `${es(v / 1e3, 1)} kB`;
  return `${es(v, 2)} ms`;
};
const WORD: Record<string, string> = {
  better: "gana",
  worse: "pierde",
  same: "empate",
  inconclusive: "no concluyente",
  tiny: "sin veredicto (las dos medias bajo 0,1 ms)",
};
const CLASS: Record<string, string> = {
  better: "good",
  worse: "bad",
  same: "eq",
  inconclusive: "eq",
  tiny: "eq",
};
const commitOf = (name: string) =>
  versions.find((v) => v.name === name)!.tree.commit;
const day = new Date(date).toLocaleString("es-AR", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const tables = versions.map((v) => {
  const head = `<tr><th>Fila</th>${COLUMNS.map(([, title, rel]) => `<th>${title}<br><span class="pill ${rel}">${PILL[rel]}</span></th>`).join("")}</tr>`;
  const body = [...TEXT_ROWS, ...TREE_ROWS]
    .filter(want)
    .map((row) => {
      const [text, rowRel] = ROW_TEXT[row]!;
      const rounds = Math.max(
        0,
        ...TIMED.map(([col]) => cells[row]?.[col]?.[v.name]?.rounds ?? 0),
      );
      const yjsNote = usedCache.length
        ? `Yjs del caché del ${usedCache.map((c) => new Date(c.date).toLocaleString("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })).join(" y ")} (carga ${usedCache.map((c) => es(c.loadMedian, 1)).join(" y ")}; no en pares)`
        : "Yjs en la misma corrida, en pares";
      const ageTip = `Medido el ${day} · modo rápido · ${v.name} = ${v.tree.label} (${commitOf(v.name)}) contra Yjs 13 y Yjs 14 · ${rounds ? `${rounds} rondas, 2 pasadas de calentamiento` : "sin rondas"} · ${yjsNote} · carga mediana ${es(loadMedian, 1)} (máx. ${es(maxLoad, 1)}) · bytes y tamaño: exactos`;
      const first = `<td><b>${row.slice(1, -1)}</b> <span class="sub">${text}</span> <span class="pill ${rowRel}">${PILL[rowRel]}</span> <span class="age" data-date="${date}" data-tip="${ageTip}" tabindex="0"></span></td>`;
      const tds = COLUMNS.map(([col, , colRel]) => {
        const c = cells[row]?.[col]?.[v.name];
        if (!c) {
          const why =
            TEXT_ROWS.includes(row) && !hasText(v.tree)
              ? "Esta versión no tiene text()"
              : "Sin dato";
          return `<td class="na" data-tip="${why}" tabindex="0">—</td>`;
        }
        const dim = Math.min(RANK[rowRel], RANK[colRel]) === 0 ? " dim" : "";
        const margin = c.ci
          ? ` · margen [${sgnPct(c.ci[0])}, ${sgnPct(c.ci[1])}] · ${c.rounds} rondas`
          : " · exacto";
        const tip = `DocNode ${unit(col, c.values.docnode)} · Yjs 13 ${unit(col, c.values.yjs13)} · Yjs 14 ${unit(col, c.values.yjs14)} · ${WORD[c.outcome]}${margin}`;
        return `<td class="pc ${CLASS[c.outcome]}${dim}" data-tip="${tip}" tabindex="0">${sgnPct(c.pct)}</td>`;
      }).join("");
      return `<tr>${first}${tds}</tr>`;
    })
    .join("\n");
  return `<div class="scroll cmp-t" data-s="${v.name}"${v === versions[0] ? "" : " hidden"}><table class="pct"><thead>${head}</thead><tbody>\n${body}\n</tbody></table></div>`;
});
const buttons = `<div class="subjects" role="group" aria-label="Versión de DocNode">${versions.map((v, i) => `<button type="button" data-s="${v.name}" aria-pressed="${i === 0}">${v.name}</button>`).join("")}</div>`;
writeFileSync(`${DIR}/table.html`, `${buttons}\n${tables.join("\n")}\n`);

console.log(`\nwrote ${DIR}/summary.json and table.html`);
console.log(
  `load median ${loadMedian.toFixed(1)} (max ${maxLoad.toFixed(1)}) · quick table, not the full method`,
);
for (const v of versions) {
  console.log(`\n${v.name} (${v.tree.commit}) against the better Yjs`);
  for (const row of [...TEXT_ROWS, ...TREE_ROWS].filter(want)) {
    const line = COLUMNS.map(([col]) => {
      const c = cells[row]?.[col]?.[v.name];
      return c
        ? `${col} ${c.pct.toFixed(0)}%${c.outcome === "inconclusive" ? "?" : ""}`
        : `${col} -`;
    }).join(" | ");
    console.log(`${row} ${line}`);
  }
}
