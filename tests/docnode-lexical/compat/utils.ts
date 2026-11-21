import {
  Doc,
  type Extension,
  type JsonDoc,
  type JsonTree,
  type Operations,
} from "@docukit/docnode";
import { openNodeDocuments } from "@docukit/docnode-lexical/compat";
import {
  createLexicalDocNodeConfig,
  syncLexicalWithDoc,
} from "@docukit/docnode-lexical";
import { $getRoot, createEditor, type LexicalEditor } from "lexical";

import stored from "./fixtures.json" with { type: "json" };
import { NODES } from "./nodes.js";

const isStoredDocument = (json: unknown): json is JsonDoc | JsonTree =>
  Array.isArray(json) && (json[0] === 14 || typeof json[0] === "string");

/**
 * Stored "node" documents, each with the Lexical state an editor of the
 * "node" mode shows when it opens it. Written by editors with the nodes of
 * `nodes.ts`, with the code of the published version (`main: …`, nested
 * nodes) and of the "node" entry point before it was removed (`node: …`,
 * format 14).
 */
export const FIXTURES = stored.map(({ name, id, json, state }) => {
  if (!isStoredDocument(json)) throw new Error(`Not a document: ${name}`);
  return { name, id, json, state };
});

const extensions = [openNodeDocuments({ nodes: NODES })];

/** The config of the "letter" documents of these tests. */
export const letterConfig = (withCompat: Extension[] = extensions) =>
  createLexicalDocNodeConfig({
    type: "docnode-lexical",
    extensions: withCompat,
  });

export const createTestEditor = () =>
  createEditor({
    namespace: "compat",
    nodes: NODES,
    onError: (error) => {
      throw error;
    },
  });

/** A stored document, opened by an editor of the "letter" mode. */
export function openLetter(json: JsonDoc | JsonTree, id: string) {
  const doc = Doc.fromJSON({ ...letterConfig(), id }, json);
  doc.forceCommit();
  const editor = createTestEditor();
  syncLexicalWithDoc(editor, doc);
  return { doc, editor, state: stateOf(editor) };
}

/** The stored document a conversion gives. */
export function converted(json: JsonDoc | JsonTree, id: string) {
  const doc = Doc.fromJSON({ ...letterConfig(), id }, json);
  doc.forceCommit();
  return doc.toJSON();
}

/** What an editor shows, as JSON stores it. */
export const stateOf = (editor: LexicalEditor): unknown =>
  JSON.parse(JSON.stringify(editor.getEditorState()));

/** The text of each top-level block an editor shows. */
export const textsOf = (editor: LexicalEditor) =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((node) => node.getTextContent()),
  );

/**
 * Two replicas that keep the operations of their edits. `sync` sends them to
 * the other one.
 */
export function connect(a: Doc, b: Doc) {
  const outboxes = new Map([a, b].map((doc) => [doc, [] as Operations[]]));
  let syncing = false;
  for (const doc of [a, b])
    doc.onChange(({ operations }) => {
      if (!syncing) outboxes.get(doc)!.push(operations);
    });
  return () => {
    syncing = true;
    for (const [doc, outbox] of outboxes)
      for (const operations of outbox.splice(0))
        (doc === a ? b : a).applyOperations(operations);
    syncing = false;
  };
}

const PARAGRAPH = {
  children: [],
  direction: null,
  format: "",
  indent: 0,
  textFormat: 0,
  textStyle: "",
  type: "paragraph",
  version: 1,
};
const TEXT = { detail: 0, format: 0, mode: "normal", style: "", version: 1 };

/** A document as `main` stores it: one paragraph of plain text per text. */
export function mainDocument(id: string, texts: string[]): JsonTree {
  const paragraph = (text: string, index: number): JsonTree => [
    `p${index}`,
    "l",
    { j: JSON.stringify(PARAGRAPH) },
    [
      [
        `t${index}`,
        "l",
        { j: JSON.stringify({ ...TEXT, text, type: "text" }) },
      ],
    ],
  ];
  const [first, ...rest] = texts.map(paragraph);
  return first
    ? [id, "docnode-lexical", {}, [first, ...rest]]
    : [id, "docnode-lexical", {}];
}
