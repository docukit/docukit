// The artifact's table from a full-method summary (all.ts → fair-summary.json): one DocNode bundle against the
// better of Yjs 13 and Yjs 14, with the same look as quick-table.ts (colors, dimmed low-relevance cells, a tooltip
// per cell and an "updated" note per row).
// usage: node scripts/fair/summary-table.ts <dir with fair-summary.json> <bundle> <label for the tooltip> [rows]
//   rows: comma list of short names, default every row of the summary except G1.8 and G1.9.
// Writes <dir>/table.html.
import { readFileSync, writeFileSync } from "node:fs";

const [DIR, LIB, LABEL, ROWS] = process.argv.slice(2) as [
  string,
  string,
  string,
  string | undefined,
];
if (!DIR || !LIB || !LABEL)
  throw new Error(
    "usage: node scripts/fair/summary-table.ts <dir> <bundle> <label> [rows]",
  );
const S = JSON.parse(readFileSync(`${DIR}/fair-summary.json`, "utf8"));

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
const ORDER = Object.keys(ROW_TEXT);
/** Column of the table, its key in the summary, its title and relevance. */
const COLUMNS: [string, string, "hi" | "mid" | "lo"][] = [
  ["bytes", "bytes por update<br><small>sin comprimir</small>", "hi"],
  ["doc", "documento<br><small>gzip</small>", "hi"],
  ["docRaw", "documento<br><small>sin comprimir</small>", "hi"],
  ["loadNoGc", "cargar<br><small>sin GC forzado</small>", "hi"],
  ["memFair", "memoria", "mid"],
  ["time", "tiempo", "mid"],
  ["save", "guardar", "lo"],
];
const EXACT = new Set(["bytes", "doc", "docRaw"]);
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
  if (col === "doc" || col === "docRaw")
    return v >= 1000 ? `${es(v / 1000, 1)} KB` : `${es(v, 0)} B`;
  if (col === "memFair")
    return v >= 1e6 ? `${es(v / 1e6, 2)} MB` : `${es(v / 1e3, 1)} kB`;
  return `${es(v, 2)} ms`;
};
const WORD: Record<string, string> = {
  better: "gana",
  worse: "pierde",
  equivalent: "empate",
  inconclusive: "no concluyente",
};
const CLASS: Record<string, string> = {
  better: "good",
  worse: "bad",
  equivalent: "eq",
};
const FLAG: Record<string, string> = {
  "low precision": "poca precisión",
  fragile: "frágil (una ronda mueve el resultado)",
};

const full = Object.keys(S.cells);
const wanted = ROWS
  ? ROWS.split(",")
  : ORDER.filter((r) => full.some((f) => f.startsWith(r)));
const runs = Object.values<any>(S.meta.runs).filter((r) => r.rounds >= 30);
const started = runs.map((r) => r.started).sort()[0];
const loads = runs.map((r) => r.loadSummary.median);
const maxLoad = Math.max(...runs.map((r) => r.loadSummary.max));
const day = new Date(started).toLocaleString("es-AR", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const head = `<tr><th>Fila</th>${COLUMNS.map(([, title, rel]) => `<th>${title}<br><span class="pill ${rel}">${PILL[rel]}</span></th>`).join("")}</tr>`;
const body = wanted
  .map((row) => {
    const name = full.find((f) => f.startsWith(row));
    const [text, rowRel] = ROW_TEXT[row] ?? [row, "lo"];
    const ageTip = `Medido el ${day} · método completo · ${LABEL} contra Yjs 13 y Yjs 14 · 30 + 30 rondas, 2 pasadas de calentamiento, pasada de GC · carga mediana ${loads.map((l) => es(l, 1)).join(" a ")} (máx. ${es(maxLoad, 1)}) · bytes y tamaño: exactos`;
    const first = `<td><b>${row.slice(1, -1)}</b> <span class="sub">${text}</span> <span class="pill ${rowRel}">${PILL[rowRel]}</span> <span class="age" data-date="${started}" data-tip="${ageTip}" tabindex="0"></span></td>`;
    const tds = COLUMNS.map(([col, , colRel]) => {
      const c = name ? S.cells[name]?.[col] : undefined;
      const x = c?.[LIB];
      if (!x) return `<td class="na" data-tip="Sin dato" tabindex="0">—</td>`;
      if (x.pct == null)
        return `<td class="na" data-tip="DocNode ${unit(col, x.mean)} · Yjs 13 ${unit(col, c.yjs13.mean)} · Yjs 14 ${unit(col, c.yjs14.mean)} · sin veredicto: las dos medias bajo 0,1 ms" tabindex="0">—</td>`;
      const dim = Math.min(RANK[rowRel], RANK[colRel]) === 0 ? " dim" : "";
      const ref = c[x.ref];
      const exact = EXACT.has(col);
      let outcome: string = x.outcome;
      let word = WORD[outcome] ?? x.text ?? outcome;
      if (exact) word = x.pct < -2 ? "gana" : x.pct > 2 ? "pierde" : "empate";
      const cls = exact
        ? x.pct < -2
          ? "good"
          : x.pct > 2
            ? "bad"
            : "eq"
        : (CLASS[outcome] ?? "eq");
      // † : the GC lands inside this window almost always in one library and almost never in the other.
      let dagger = "";
      if (x.gc && ref?.gc && x.gc.n && ref.gc.n) {
        const a = x.gc.pauseRounds / x.gc.n,
          b = ref.gc.pauseRounds / ref.gc.n;
        if (Math.abs(a - b) > 0.2)
          dagger = ` · † el tamaño depende de dónde cae el GC (pausa adentro en ${x.gc.pauseRounds}/${x.gc.n} rondas; referencia ${ref.gc.pauseRounds}/${ref.gc.n}); sin la pausa: ${unit(col, x.gc.noPauseMean)}`;
      }
      const flags = (x.flags ?? [])
        .map((f: string) => FLAG[f] ?? f)
        .map((f: string) => ` · ${f}`)
        .join("");
      const margin = exact
        ? " · exacto"
        : x.ci
          ? ` · margen [${sgnPct(x.ci[0])}, ${sgnPct(x.ci[1])}]`
          : "";
      const tip = `DocNode ${unit(col, x.mean)} · Yjs 13 ${unit(col, c.yjs13.mean)} · Yjs 14 ${unit(col, c.yjs14.mean)} · ${word}${margin}${flags}${dagger}`;
      return `<td class="pc ${cls}${dim}" data-tip="${tip}" tabindex="0">${sgnPct(x.pct)}${dagger ? " †" : ""}</td>`;
    }).join("");
    return `<tr>${first}${tds}</tr>`;
  })
  .join("\n");
writeFileSync(
  `${DIR}/table.html`,
  `<div class="scroll"><table class="pct"><thead>${head}</thead><tbody>\n${body}\n</tbody></table></div>\n`,
);
console.log(`wrote ${DIR}/table.html (${wanted.length} rows)`);
