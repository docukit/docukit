import {
  defineNode,
  defineState,
  defineText,
  type Doc,
  type DocConfig,
  type Extension,
  type JsonDoc,
  type JsonTree,
} from "@docukit/docnode";
import type { LexicalEditor } from "lexical";

import { syncFlat } from "./flat/binding.js";
import { INHERIT } from "./flat/inherit.js";
import type { syncLexicalWithDocPresenceOptions } from "./types.js";

/**
 * The root state that says a document merges its text letter by letter.
 * Documents stored before it existed keep a DocNode per Lexical node instead
 * (the `"node"` mode), which this package no longer opens.
 */
const TEXT_CONFLICTS = "~textConflicts";

const NODE_DOCUMENT_ERROR =
  "This document keeps a DocNode per Lexical node (the former " +
  '"node" mode), which @docukit/docnode-lexical no longer opens: documents ' +
  "now merge their text letter by letter. Add `openNodeDocuments` from " +
  '"@docukit/docnode-lexical/compat" to its config to convert it as it loads.';

const FOREIGN_DOCUMENT_ERROR =
  "syncLexicalWithDoc needs a document made with createLexicalDocNodeConfig.";

/** The root of each document type: one text (`t`), its blocks as lines. */
const roots = new Map<string, ReturnType<typeof rootNode>>();
const rootNode = (type: string) =>
  defineNode({
    type,
    state: {
      [TEXT_CONFLICTS]: defineState({
        fromJSON: (json) => (json === "letter" ? "letter" : ""),
      }),
      t: defineText(INHERIT),
    },
  });

function rootOf(type: string) {
  let node = roots.get(type);
  if (!node) roots.set(type, (node = rootNode(type)));
  return node;
}

/** Documents built with `createLexicalDocNodeConfig`. */
const lexicalDocs = new WeakSet<Doc>();

/** Whether a stored document merges its text letter by letter. */
const storesLetters = (json: JsonDoc | JsonTree) => {
  const state = json[2];
  // A stored document's empty state is `0`.
  if (state === 0) return false;
  return typeof json[0] === "string"
    ? state[TEXT_CONFLICTS] === JSON.stringify("letter")
    : state[TEXT_CONFLICTS] === "letter";
};

/**
 * The config of Lexical documents, whose concurrent text edits merge letter
 * by letter. A stored document of the former `"node"` mode throws, unless an
 * extension before converts it.
 */
export const createLexicalDocNodeConfig = (
  config?: Omit<Partial<DocConfig>, "extensions"> & {
    /** More extensions, like a converter of older documents, that load first. */
    extensions?: Extension[];
  },
): DocConfig => {
  const { extensions = [], ...docConfig } = config ?? {};
  const type = docConfig.type ?? "docnode-lexical";
  const root = rootOf(type);
  return {
    type,
    ...docConfig,
    extensions: [
      ...extensions,
      {
        nodes: [root],
        register: (doc) => {
          lexicalDocs.add(doc);
          // A new document records its mode. `Doc.fromJSON` then replaces
          // this root with the stored one, which has it too.
          if (doc.root.is(root)) doc.root.state[TEXT_CONFLICTS].set("letter");
        },
        load: (json) => {
          if (!storesLetters(json)) throw new Error(NODE_DOCUMENT_ERROR);
          return json;
        },
      },
    ],
  };
};

/** Sync Lexical and a document. Returns a cleanup function. */
export function syncLexicalWithDoc(
  editor: LexicalEditor,
  doc: Doc,
  options?: syncLexicalWithDocPresenceOptions,
): () => void {
  const root = doc.root;
  if (!lexicalDocs.has(doc) || !root.is(rootOf(root.type)))
    throw new Error(FOREIGN_DOCUMENT_ERROR);
  return syncFlat(editor, doc, root.state.t, options);
}
