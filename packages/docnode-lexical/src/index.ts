import { type Doc } from "@docukit/docnode";
import { type LexicalEditor } from "lexical";

import { initializeEditorFromDoc } from "./initializeEditorFromDoc.js";
import {
  LexicalDocNode,
  createLexicalDoc,
  lexicalDocNodeConfig,
} from "./lexicalDocNode.js";
import { syncDocNodeToLexical } from "./syncDocNodeToLexical.js";
import { syncLexicalToDocNode } from "./syncLexicalToDocNode.js";
import { syncPresence } from "./syncPresence.js";

import type { Presence } from "./syncPresence.js";
import type { syncLexicalWithDocPresenceOptions } from "./types.js";

export { syncPresence } from "./syncPresence.js";
export type {
  Presence,
  PresenceHandle,
  LexicalPresence,
} from "./syncPresence.js";

export type {
  KeyBinding,
  PresenceSelection,
  syncLexicalWithDocPresenceOptions,
} from "./types.js";

type EditorBinding = {
  presenceHandle: ReturnType<typeof syncPresence> | undefined;
  lastPresence: Presence | undefined;
};

const bindingByEditor = new WeakMap<LexicalEditor, EditorBinding>();

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
 * @param editor - Lexical editor instance.
 * @param doc - DocNode document. If omitted, a new doc is created.
 * @param presenceOptions - Optional. When setPresence is provided, selection is synced to presence and renderPresence is returned for remote cursors.
 * @returns Cleanup function to unbind the editor from the doc and presence.
 */
export function syncLexicalWithDoc(
  editor: LexicalEditor,
  doc: Doc,
  presenceOptions?: syncLexicalWithDocPresenceOptions,
): () => void {
  const keyBinding = initializeEditorFromDoc(editor, doc);
  const { lexicalKeyToDocNodeId, docNodeIdToLexicalKey } = keyBinding;

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

  const { setPresence: rawSetPresence, user } = presenceOptions ?? {};
  const presenceHandle = rawSetPresence
    ? syncPresence(editor, keyBinding, (selection) =>
        rawSetPresence(
          selection == null
            ? undefined
            : user?.name != null && user?.color != null
              ? { ...selection, name: user.name, color: user.color }
              : selection,
        ),
      )
    : undefined;

  bindingByEditor.set(editor, { presenceHandle, lastPresence: undefined });

  return () => {
    const binding = bindingByEditor.get(editor);
    bindingByEditor.delete(editor);
    binding?.presenceHandle?.cleanup();
    unregisterLexicalListener();
    unregisterDocListener();
    keyBinding.lexicalKeyToDocNodeId.clear();
    keyBinding.docNodeIdToLexicalKey.clear();
  };
}

export { LexicalDocNode, lexicalDocNodeConfig, createLexicalDoc };
