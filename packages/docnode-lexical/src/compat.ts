// Opens a stored "node" document in a "letter" binding by converting it as it
// loads. It reads the stored document on its own, with no code of the "node"
// mode, and writes it with the public API of the "letter" mode: it works the
// same once the "node" mode is gone.
import {
  defineNode,
  defineState,
  Doc,
  type DocNode,
  type Extension,
  type JsonDoc,
  type JsonTree,
  type NodeIdGenerator,
} from "@docukit/docnode";
import {
  $getRoot,
  $isElementNode,
  $parseSerializedNode,
  createEditor,
  type CreateEditorArgs,
  type ElementNode,
  type SerializedLexicalNode,
} from "lexical";

import { createLexicalDocNodeConfig, syncLexicalWithDoc } from "./document.js";

type StoredNode = SerializedLexicalNode & { [key: string]: unknown };

/**
 * What a "node" document leaves out of a Lexical element of version 1: the
 * fields that keep these values, and under `MISSING` the ones it does not
 * have. Documents of `main` store whole nodes.
 */
const ELEMENT_DEFAULTS = {
  children: [],
  direction: null,
  format: "",
  indent: 0,
  textFormat: 0,
  textStyle: "",
  type: "paragraph",
  version: 1,
};
const MISSING = "~";

/** What a `"letter"` document stores at its root, and a "node" one does not. */
const LETTER_MODE = "~textConflicts";

/** Whether a stored document is already a `"letter"` one. */
const storesLetters = (json: JsonDoc | JsonTree) => {
  const state = json[2];
  // A stored document's empty state is `0`.
  if (state === 0) return false;
  return typeof json[0] === "string"
    ? state[LETTER_MODE] === JSON.stringify("letter")
    : state[LETTER_MODE] === "letter";
};

const isWholeNode = (json: unknown): json is StoredNode =>
  typeof json === "object" && json !== null && "version" in json;

/** A stored node's JSON, whole or compact (see `isWholeNode`). */
function expandNode(json: unknown): StoredNode {
  if (isWholeNode(json)) return json;
  const { [MISSING]: missing, ...compact }: Record<string, unknown> =
    typeof json === "object" && json !== null ? { ...json } : {};
  const node: StoredNode = { ...ELEMENT_DEFAULTS, children: [], ...compact };
  if (Array.isArray(missing))
    for (const key of missing) Reflect.deleteProperty(node, String(key));
  return node;
}

/** The DocNode of a Lexical node in a "node" document: its JSON in `j`. */
const StoredLexicalNode = defineNode({
  type: "l",
  state: { j: defineState({ fromJSON: expandNode }) },
});

/**
 * The session of the letters a conversion writes, the same in every replica:
 * replicas that convert the same document get the same letters, and edits of
 * one apply in the others. Every id and session of a document is longer.
 */
const SESSION = "c";
/** Writes the letters of `SESSION`, and takes any stored id as it is. */
const LETTERS: NodeIdGenerator = {
  generate: () => `${SESSION}.0`,
  validate: () => true,
};
/**
 * For `createLexicalDocNodeConfig`: a stored document of the former `"node"`
 * mode loads as the `"letter"` document of the same Lexical content. Add it to `extensions`; documents already in `"letter"` mode load
 * as they are.
 *
 * Every replica converts a document the same way, so replicas that load the
 * same stored document can edit it together. A document must not keep
 * `"node"` operations to apply after it loads: they would no longer apply.
 *
 * @param editorConfig - The Lexical nodes of the editor (the `nodes` of its
 * config): they tell blocks from inline nodes.
 */
export function openNodeDocuments(
  editorConfig?: Pick<CreateEditorArgs, "nodes">,
): Extension {
  return {
    load: (json, id) => {
      try {
        return storesLetters(json)
          ? json
          : nodeToLetter(json, id, editorConfig);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Could not convert a stored "node" document to "letter": ${reason}`,
          { cause: error },
        );
      }
    },
  };
}

/**
 * The `"letter"` document of a "node" one: an editor shows it as the "node"
 * binding does, and the `"letter"` binding writes what it shows.
 */
function nodeToLetter(
  json: JsonDoc | JsonTree,
  id: string,
  editorConfig: Pick<CreateEditorArgs, "nodes"> | undefined,
): JsonDoc {
  const type = json[1];
  const stored = Doc.fromJSON(
    {
      type,
      id,
      extensions: [{ nodes: [StoredLexicalNode] }],
      nodeIdGenerator: LETTERS,
    },
    json,
  );
  const doc = new Doc(
    createLexicalDocNodeConfig({ type, id, nodeIdGenerator: LETTERS }),
  );
  doc.forceCommit();
  const editor = createEditor({
    ...editorConfig,
    onError: (error) => {
      throw error;
    },
  });
  syncLexicalWithDoc(editor, doc);
  editor.update(() => $append(stored.root, $getRoot()), { discrete: true });
  return doc.toJSON();
}

/** The Lexical nodes of `parent`'s DocNodes, as the "node" binding builds them. */
function $append(parent: DocNode, into: ElementNode) {
  parent.children().forEach((child) => {
    // The root's type, the only other one, is never a child.
    if (!child.is(StoredLexicalNode)) return;
    const node = $parseSerializedNode(child.state.j.get());
    into.append(node);
    if ($isElementNode(node)) $append(child, node);
  });
}
