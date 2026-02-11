import { type Doc, type DocNode } from "@docukit/docnode";
import {
  $getRoot,
  $isElementNode,
  $parseSerializedNode,
  COLLABORATION_TAG,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";

import { LexicalDocNode } from "./lexicalDocNode.js";
import type { KeyBinding } from "./types.js";

/**
 * Loads the DocNode document into the Lexical editor and returns the key binding
 * mapping Lexical keys to DocNode IDs (and vice versa).
 */
export function initializeEditorFromDoc(
  editor: LexicalEditor,
  doc: Doc,
): KeyBinding {
  const keyBinding: KeyBinding = {
    lexicalKeyToDocNodeId: new Map<string, string>(),
    docNodeIdToLexicalKey: new Map<string, string>(),
  };
  const { lexicalKeyToDocNodeId, docNodeIdToLexicalKey } = keyBinding;

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

          if ($isElementNode(lexicalNode)) {
            processChildren(child, lexicalNode);
          }
        });
      };

      processChildren(doc.root, root);
    },
    { discrete: true, tag: COLLABORATION_TAG },
  );

  return keyBinding;
}
