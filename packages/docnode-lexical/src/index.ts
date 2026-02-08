import { type Doc } from "@docukit/docnode";
import { type LexicalEditor } from "lexical";
import { initializeEditorFromDoc } from "./initializeEditorFromDoc.js";
import { syncDocNodeToLexical } from "./syncDocNodeToLexical.js";
import { syncLexicalToDocNode } from "./syncLexicalToDocNode.js";
import { syncPresence } from "./presence/index.js";

import type { syncLexicalWithDocPresenceOptions } from "./types.js";

/**
 * Sync Lexical and DocNode. Presence is optional. Returns a cleanup function to unbind.
 */
export function syncLexicalWithDoc(
  editor: LexicalEditor,
  doc: Doc,
  presenceOptions?: syncLexicalWithDocPresenceOptions,
): () => void {
  // 1. Set Lexical content to match DocNode and build key binding
  const keyBinding = initializeEditorFromDoc(editor, doc);

  // 2. Sync Lexical → DocNode. Every time Lexical content changes, DocNode is updated.
  const offLexicalListener = syncLexicalToDocNode(doc, editor, keyBinding);

  // 3. Sync DocNode → Lexical. Every time DocNode changes, Lexical is updated.
  const offDocListener = syncDocNodeToLexical(doc, editor, keyBinding);

  // 4. Sync presence (optional). Handles local selection → presence and remote cursors.
  const presenceHandle = syncPresence(editor, keyBinding, presenceOptions);

  return () => {
    presenceHandle?.cleanup();
    offLexicalListener();
    offDocListener();
    keyBinding.lexicalKeyToDocNodeId.clear();
    keyBinding.docNodeIdToLexicalKey.clear();
  };
}
