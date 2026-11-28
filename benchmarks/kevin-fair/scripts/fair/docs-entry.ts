// App-shaped documents probe (synthetic, seeded content). `make` builds and saves a document; `measure` loads it in a
// fresh process and times load / save, with FAIR_IC=1 also the thread's instruction count of each window.
// node --expose-gc --max-old-space-size=2048 <bundle> make <kind> <file>
// node --expose-gc --max-old-space-size=2048 <bundle> measure <kind> <file> <out.json>
// env FAIR_WARM (default 2): warm-up loads and saves before the measured ones.
// kinds: explorer-ulid (file-explorer tree, 2,000 nodes, ULID ids from a custom generator), explorer
// (same tree, DocNode's default ids), lexical (~10,000 docnode-lexical nodes).
import { Doc, defineNode, defineState, string } from "@docukit/docnode";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
const IC = process.env.FAIR_IC === "1";
// Loaded only with FAIR_IC=1, so that normal runs do not load node:ffi (it would change the heap they measure).
const counts = IC
  ? (await import("./icount.ts")).counts
  : () => ({ ins: 0n, cyc: 0n });
const ins = () => counts().ins;

// Seeded PRNG (mulberry32): the same content in every bundle.
let seed = 12345;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)]!;

const CROCK = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let time = Date.UTC(2026, 0, 1);
const ulid = () => {
  time += 1000 + Math.floor(rand() * 3e6);
  let s = "";
  let x = time;
  for (let i = 0; i < 10; i++) {
    s = CROCK[x % 32] + s;
    x = Math.floor(x / 32);
  }
  for (let i = 0; i < 16; i++) s += CROCK[Math.floor(rand() * 32)];
  return s;
};

const Active = defineNode({ type: "active", state: {} });
const Trash = defineNode({ type: "trash", state: {} });
const Folder = defineNode({
  type: "folder",
  state: { title: string("Untitled folder") },
});
const File = defineNode({ type: "file", state: { title: string("") } });
// Spanish words on purpose: like real text, they include non-ASCII characters. docs-yjs-tree.ts uses the same lists.
const EXPLORER_WORDS =
  "informe notas reunión presupuesto diseño proyecto cliente borrador final revisión plan ideas tareas agenda viaje recetas facturas contrato manual guía".split(
    " ",
  );
const explorerTitle = () => {
  const n = 1 + Math.floor(rand() * 3);
  const w: string[] = [];
  for (let i = 0; i < n; i++) w.push(pick(EXPLORER_WORDS));
  const s = w.join(" ");
  return (
    s[0]!.toUpperCase() +
    s.slice(1) +
    (rand() < 0.3 ? " " + (2020 + Math.floor(rand() * 7)) : "")
  );
};

const Lexical = defineNode({
  type: "l",
  state: {
    j: defineState({
      fromJSON: (json) => (json ?? {}) as Record<string, unknown>,
    }),
  },
});
const LEX_WORDS =
  "el la de que y en un una los las por con para como pero más este esta casa tiempo mundo vida día año cosa hombre mujer parte ciudad trabajo agua noche palabra lugar camino historia escribir leer pensar hablar mirar nuevo grande pequeño primero último bueno largo".split(
    " ",
  );
const sentence = () => {
  const n = 2 + Math.floor(rand() * 12);
  const w: string[] = [];
  for (let i = 0; i < n; i++) w.push(pick(LEX_WORDS));
  return w.join(" ") + (rand() < 0.5 ? ". " : " ");
};

const configs = {
  "explorer-ulid": () => ({
    type: "explorer",
    extensions: [{ nodes: [Active, Trash, Folder, File] }],
    nodeIdGenerator: {
      generate: ulid,
      validate: (s: string) => s.length === 26,
    },
  }),
  explorer: () => ({
    type: "explorer",
    extensions: [{ nodes: [Active, Trash, Folder, File] }],
  }),
  lexical: () => ({
    type: "docnode-lexical",
    extensions: [{ nodes: [Lexical] }],
  }),
};
type Kind = keyof typeof configs;

let lastRootId = "";
function make(kind: Kind) {
  const doc = new Doc(configs[kind]());
  if (kind === "lexical") {
    let count = 0;
    const paragraphs = [];
    while (count < 10000) {
      const p = doc.createNode(Lexical);
      p.state.j.set({
        type: "paragraph",
        format: "",
        indent: 0,
        direction: "ltr",
        textFormat: 0,
        version: 1,
      });
      count++;
      const texts = [];
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n && count < 10000; i++) {
        const t = doc.createNode(Lexical);
        t.state.j.set({
          type: "text",
          text: sentence(),
          format: rand() < 0.2 ? 1 : 0,
          detail: 0,
          mode: "normal",
          style: "",
          version: 1,
        });
        texts.push(t);
        count++;
      }
      p.append(...texts);
      paragraphs.push(p);
    }
    doc.root.append(...paragraphs);
  } else {
    const active = doc.createNode(Active),
      trash = doc.createNode(Trash);
    doc.root.append(active, trash);
    let count = 0;
    const fill = (parent: any, depth: number) => {
      const n = depth === 0 ? 12 : 3 + Math.floor(rand() * 8);
      for (let i = 0; i < n && count < 2000; i++) {
        const isFolder = depth < 3 && rand() < 0.35;
        const node: any = doc.createNode(isFolder ? Folder : File);
        count++;
        node.state.title.set(explorerTitle());
        parent.append(node);
        if (isFolder) fill(node, depth + 1);
      }
    };
    while (count < 2000) fill(active, 0);
  }
  doc.forceCommit();
  lastRootId = doc.root.id;
  return JSON.stringify(doc.toJSON());
}

const [mode, kind, file, out] = process.argv.slice(2) as [
  string,
  Kind,
  string,
  string,
];
if (mode === "make") {
  const text = make(kind);
  writeFileSync(file, text);
  writeFileSync(file + ".id", lastRootId);
} else {
  const text = readFileSync(file, "utf8");
  const g = (globalThis as any).gc as () => void;
  // Warm-up (FAIR_WARM, default 2): load and save the same document first, so the code is already optimized.
  const id = readFileSync(file + ".id", "utf8");
  for (let w = 0; w < Number(process.env.FAIR_WARM ?? 2); w++) {
    const warm = Doc.fromJSON({ ...configs[kind](), id }, JSON.parse(text));
    warm.forceCommit();
    JSON.stringify(warm.toJSON());
  }
  g();
  g();
  const h0 = process.memoryUsage().heapUsed;
  const i0 = ins();
  const t0 = performance.now();
  let json: any = JSON.parse(text);
  const tp = performance.now();
  const ip = ins();
  const doc = Doc.fromJSON(
    { ...configs[kind](), id: readFileSync(file + ".id", "utf8") },
    json,
  );
  doc.forceCommit();
  const t1 = performance.now();
  const i1 = ins();
  json = undefined;
  g();
  g();
  const h1 = process.memoryUsage().heapUsed;
  const nodes = (doc as any)._nodeMap.size;
  const j0 = ins();
  const t2 = performance.now();
  const savedJson = doc.toJSON();
  const ts = performance.now();
  const is = ins();
  const saved = JSON.stringify(savedJson);
  const t3 = performance.now();
  const i3 = ins();
  const gz = gzipSync(Buffer.from(saved), { level: 9 }).length;
  // Data memory without the code compiled on the first load: a second load.
  g();
  g();
  const h2 = process.memoryUsage().heapUsed;
  let json2: any = JSON.parse(text);
  const doc2 = Doc.fromJSON(
    { ...configs[kind](), id: readFileSync(file + ".id", "utf8") },
    json2,
  );
  doc2.forceCommit();
  json2 = undefined;
  g();
  g();
  const memWarm = (process.memoryUsage().heapUsed - h2) / nodes;
  (globalThis as any).keep2 = doc2;
  const r: Record<string, unknown> = {
    kind,
    nodes,
    raw: Buffer.byteLength(saved),
    gzip: gz,
    load: t1 - t0,
    save: t3 - t2,
    parse: tp - t0,
    fromJSON: t1 - tp,
    toJSON: ts - t2,
    stringify: t3 - ts,
    memFair: h1 - h0,
    memWarm: memWarm * nodes,
    roundTrip: saved === text,
  };
  if (IC)
    Object.assign(r, {
      loadIns: Number(i1 - i0),
      saveIns: Number(i3 - j0),
      parseIns: Number(ip - i0),
      fromJSONIns: Number(i1 - ip),
      toJSONIns: Number(is - j0),
      stringifyIns: Number(i3 - is),
    });
  writeFileSync(out, JSON.stringify(r));
}
