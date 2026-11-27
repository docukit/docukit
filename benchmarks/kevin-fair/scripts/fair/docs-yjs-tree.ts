// The same seeded content as the DocNode probe (docs-entry.ts, kinds "explorer" and "lexical"), as a plain tree of
// { type, attrs, children } that docs-yjs.ts turns into Yjs elements. The random calls run in the same order as in
// docs-entry.ts, so both probes build the same documents.
type TreeNode = {
  type: string;
  attrs: Record<string, unknown>;
  children: TreeNode[];
};
let seed = 12345;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)]!;
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
export function tree(kind: string): TreeNode[] {
  if (kind === "lexical") {
    let count = 0;
    const paragraphs: TreeNode[] = [];
    while (count < 10000) {
      const p: TreeNode = {
        type: "l",
        attrs: {
          j: {
            type: "paragraph",
            format: "",
            indent: 0,
            direction: "ltr",
            textFormat: 0,
            version: 1,
          },
        },
        children: [],
      };
      count++;
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n && count < 10000; i++) {
        p.children.push({
          type: "l",
          attrs: {
            j: {
              type: "text",
              text: sentence(),
              format: rand() < 0.2 ? 1 : 0,
              detail: 0,
              mode: "normal",
              style: "",
              version: 1,
            },
          },
          children: [],
        });
        count++;
      }
      paragraphs.push(p);
    }
    return paragraphs;
  }
  const active: TreeNode = { type: "active", attrs: {}, children: [] },
    trash: TreeNode = { type: "trash", attrs: {}, children: [] };
  let count = 0;
  const fill = (parent: TreeNode, depth: number) => {
    const n = depth === 0 ? 12 : 3 + Math.floor(rand() * 8);
    for (let i = 0; i < n && count < 2000; i++) {
      const isFolder = depth < 3 && rand() < 0.35;
      const node: TreeNode = {
        type: isFolder ? "folder" : "file",
        attrs: {},
        children: [],
      };
      count++;
      node.attrs.title = explorerTitle();
      parent.children.push(node);
      if (isFolder) fill(node, depth + 1);
    }
  };
  while (count < 2000) fill(active, 0);
  return [active, trash];
}
