// App-shaped documents probe for Yjs (same content as the DocNode probe: docs-yjs-tree.ts, the same seeded tree).
// node --expose-gc --max-old-space-size=2048 docs-yjs.ts make <yjs13|yjs14> <kind> <file>
// node --expose-gc --max-old-space-size=2048 docs-yjs.ts measure <yjs13|yjs14> <kind> <file> <out.json>
// env FAIR_WARM (default 2): warm-up loads and saves before the measured ones.
// `measure` has the same windows as the DocNode probe, in a fresh process: load the stored doc (applyUpdateV2),
// memory (first load and, after a throw-away load, the warm one), then save (encodeStateAsUpdateV2 of the loaded doc), gzip.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const W =
  process.env.W ?? resolve(fileURLToPath(new URL("../..", import.meta.url)));
const [mode, lib, kind, file, out] = process.argv.slice(2) as [
  string,
  "yjs13" | "yjs14",
  string,
  string,
  string,
];
const Y: any = await import(
  pathToFileURL(
    lib === "yjs13"
      ? `${W}/cb/benchmarks/yjs/node_modules/yjs/dist/yjs.mjs`
      : `${W}/cb/benchmarks/yjs14/node_modules/@y/y/src/index.js`,
  ).href
);
const api =
  lib === "yjs13"
    ? {
        root: (d: any) => d.getXmlFragment("root"),
        el: (t: string) => new Y.XmlElement(t),
        setAttr: (e: any, k: string, v: unknown) => e.setAttribute(k, v),
      }
    : {
        root: (d: any) => d.get("root"),
        el: (t: string) => new Y.Node(t),
        setAttr: (e: any, k: string, v: unknown) => e.setAttr(k, v),
      };
if (mode === "make") {
  // Loaded only here, so the measure process does not hold the generator.
  const { tree } = await import("./docs-yjs-tree.ts");
  const doc = new Y.Doc();
  const root = api.root(doc);
  let nodes = 0;
  const add = (parent: any, items: any[]) => {
    const els = items.map((it) => {
      const e = api.el(it.type);
      nodes++;
      return e;
    });
    parent.insert(0, els);
    items.forEach((it, i) => {
      for (const k in it.attrs) api.setAttr(els[i], k, it.attrs[k]);
      if (it.children.length) add(els[i], it.children);
    });
  };
  doc.transact(() => add(root, tree(kind)));
  writeFileSync(file, Y.encodeStateAsUpdateV2(doc));
  writeFileSync(file + ".nodes", String(nodes));
} else {
  const bytes = new Uint8Array(readFileSync(file));
  const nodes = Number(readFileSync(file + ".nodes", "utf8"));
  const g = (globalThis as any).gc as () => void;
  // Warm-up (FAIR_WARM, default 2): load and save the same document first, so the code is already optimized.
  for (let w = 0; w < Number(process.env.FAIR_WARM ?? 2); w++) {
    const warm = new Y.Doc();
    Y.applyUpdateV2(warm, bytes);
    Y.encodeStateAsUpdateV2(warm);
  }
  g();
  g();
  const h0 = process.memoryUsage().heapUsed;
  const t0 = performance.now();
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, bytes);
  const t1 = performance.now();
  g();
  g();
  const h1 = process.memoryUsage().heapUsed;
  const t2 = performance.now();
  const saved: Uint8Array = Y.encodeStateAsUpdateV2(doc);
  const t3 = performance.now();
  const gz = gzipSync(saved, { level: 9 }).length;
  g();
  g();
  const h2 = process.memoryUsage().heapUsed;
  const doc2 = new Y.Doc();
  Y.applyUpdateV2(doc2, bytes);
  g();
  g();
  const memWarm = process.memoryUsage().heapUsed - h2;
  (globalThis as any).keep2 = doc2;
  (globalThis as any).keep = doc;
  writeFileSync(
    out,
    JSON.stringify({
      kind,
      nodes,
      raw: saved.length,
      gzip: gz,
      load: t1 - t0,
      save: t3 - t2,
      memFair: h1 - h0,
      memWarm,
    }),
  );
}
process.exit(0);
