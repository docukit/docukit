import { type Doc } from "@docukit/docnode";
import { type LexicalEditor } from "lexical";
import { initializeEditorFromDoc } from "./initializeEditorFromDoc.js";
import { syncDocNodeToLexical } from "./syncDocNodeToLexical.js";
import { syncLexicalToDocNode } from "./syncLexicalToDocNode.js";
import {
  syncPresence,
  type Presence,
  type PresenceHandle,
} from "./syncPresence.js";

import type { syncLexicalWithDocPresenceOptions } from "./types.js";

const bindingByEditor = new WeakMap<
  LexicalEditor,
  {
    presenceHandle: PresenceHandle | undefined;
    lastPresence: Presence | undefined;
  }
>();

/**
 * Update remote cursors for an editor. Call this when presence data changes
 * (e.g. from a React effect). Uses referential equality to no-op when unchanged.
 */
export function updatePresence(
  editor: LexicalEditor,
  presence: Presence,
): void {
  const binding = bindingByEditor.get(editor);
  if (!binding?.presenceHandle) return;
  if (presence === binding.lastPresence) return;
  binding.lastPresence = presence;
  binding.presenceHandle.updateRemoteCursors(presence);
}

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

  bindingByEditor.set(editor, { presenceHandle, lastPresence: undefined });

  return () => {
    const binding = bindingByEditor.get(editor);
    bindingByEditor.delete(editor);
    binding?.presenceHandle?.cleanup();
    offLexicalListener();
    offDocListener();
    keyBinding.lexicalKeyToDocNodeId.clear();
    keyBinding.docNodeIdToLexicalKey.clear();
  };
}
