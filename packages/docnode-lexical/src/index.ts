import {
  defineNode,
  defineState,
  Doc,
  type DocConfig,
  type DocNode,
} from "@docukit/docnode";
import {
  $getRoot,
  $isElementNode,
  $parseSerializedNode,
  COLLABORATION_TAG,
  createEditor,
  type CreateEditorArgs,
  isLexicalEditor,
  type LexicalEditor,
  type LexicalNode,
  type SerializedLexicalNode,
} from "lexical";

import { syncDocNodeToLexical } from "./syncDocNodeToLexical.js";
import { syncLexicalToDocNode } from "./syncLexicalToDocNode.js";

export { syncPresence } from "./syncPresence.js";
export type {
  LocalSelection,
  Presence,
  PresenceHandle,
  LexicalPresence,
} from "./syncPresence.js";

/** Key mapping between Lexical keys and DocNode IDs */
export type KeyBinding = {
  /** Convert a Lexical node key to a DocNode ID */
  lexicalKeyToDocNodeId: Map<string, string>;
  /** Convert a DocNode ID to a Lexical node key */
  docNodeIdToLexicalKey: Map<string, string>;
};

/**
 *
 * @param editorOrConfig - A Lexical editor instance or a CreateEditorArgs object.
 * @param doc - A DocNode document instance. If no doc is provided, it will create a new one.
 * @returns An object with the Lexical editor, DocNode document instance, key binding, and a cleanup function.
 */
export function docToLexical(
  editorOrConfig: LexicalEditor | CreateEditorArgs,
  // TODO: review this
  doc = Doc.fromJSON({ extensions: [{ nodes: [LexicalDocNode] }] }, [
    "01kc52hq510g6y44jhq0wqrjb3",
    "root",
    {},
  ]),
): {
  editor: LexicalEditor;
  doc: Doc;
  keyBinding: KeyBinding;
  cleanup: () => void;
} {
  const lexicalKeyToDocNodeId = new Map<string, string>();
  const docNodeIdToLexicalKey = new Map<string, string>();

  const editor = isLexicalEditor(editorOrConfig)
    ? editorOrConfig
    : createEditor(editorOrConfig);

  editor.update(
    () => {
      const root = $getRoot();
      root.clear();

      const processChildren = (
        parentDocNode: DocNode,
        parentLexicalNode: LexicalNode,
      ) => {
        parentDocNode.children().forEach((child) => {
          if (!child.is(LexicalDocNode))
            throw new Error("Expected child to be a LexicalDocNode");
          const serializedLexicalNode = child.state.j.get();

          const lexicalNode = $parseSerializedNode(serializedLexicalNode);
          lexicalKeyToDocNodeId.set(lexicalNode.getKey(), child.id);
          docNodeIdToLexicalKey.set(child.id, lexicalNode.getKey());

          if ($isElementNode(parentLexicalNode)) {
            parentLexicalNode.append(lexicalNode);
          }

          // Recursively process children
          if ($isElementNode(lexicalNode)) {
            processChildren(child, lexicalNode);
          }
        });
      };

      processChildren(doc.root, root);
    },
    { discrete: true, tag: COLLABORATION_TAG },
  );

  const unregisterLexicalListener = syncLexicalToDocNode(
    doc,
    editor,
    lexicalKeyToDocNodeId,
    docNodeIdToLexicalKey,
  );

  const unregisterDocListener = syncDocNodeToLexical(
    doc,
    editor,
    lexicalKeyToDocNodeId,
    docNodeIdToLexicalKey,
  );

  const cleanup = () => {
    unregisterLexicalListener();
    unregisterDocListener();
    lexicalKeyToDocNodeId.clear();
    docNodeIdToLexicalKey.clear();
  };

  const keyBinding: KeyBinding = {
    lexicalKeyToDocNodeId,
    docNodeIdToLexicalKey,
  };

  return { editor, doc, keyBinding, cleanup };
}

export const LexicalDocNode = defineNode({
  type: "l",
  state: {
    j: defineState({
      fromJSON: (json) =>
        (json ?? {}) as SerializedLexicalNode & { [key: string]: unknown },
    }),
  },
});

export const lexicalDocNodeConfig: DocConfig = {
  type: "docnode-lexical",
  extensions: [{ nodes: [LexicalDocNode] }],
};
