import { defineNode, defineState, Doc, type DocNode } from "docnode";
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

/**
 *
 * @param editorOrConfig - A Lexical editor instance or a CreateEditorArgs object.
 * @param doc - A DocNode document instance. If no doc is provided, it will create a new one.
 * @returns A Lexical editor and DocNode document instance.
 */
export function docToLexical(
  editorOrConfig: LexicalEditor | CreateEditorArgs,
  // TODO: review this
  doc = Doc.fromJSON({ extensions: [{ nodes: [LexicalDocNode] }] }, [
    "01kc52hq510g6y44jhq0wqrjb3",
    "root",
    {},
  ]),
): { editor: LexicalEditor; doc: Doc } {
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

  syncLexicalToDocNode(
    doc,
    editor,
    lexicalKeyToDocNodeId,
    docNodeIdToLexicalKey,
  );

  syncDocNodeToLexical(
    doc,
    editor,
    lexicalKeyToDocNodeId,
    docNodeIdToLexicalKey,
  );

  return { editor, doc };
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
