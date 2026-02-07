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
  type LexicalEditor,
  type LexicalNode,
  type SerializedLexicalNode,
} from "lexical";

import { syncDocNodeToLexical } from "./syncDocNodeToLexical.js";
import { syncLexicalToDocNode } from "./syncLexicalToDocNode.js";
import { syncPresence } from "./syncPresence.js";

import type { Presence } from "./syncPresence.js";

export { syncPresence } from "./syncPresence.js";
export type {
  Presence,
  PresenceHandle,
  LexicalPresence,
} from "./syncPresence.js";

/** Key mapping between Lexical keys and DocNode IDs */
export type KeyBinding = {
  lexicalKeyToDocNodeId: Map<string, string>;
  docNodeIdToLexicalKey: Map<string, string>;
};

/** Selection data (DocNode IDs). Optional name/color when enriched for presence. */
export type PresenceSelection = {
  anchor: { key: string; offset: number };
  focus: { key: string; offset: number };
  name?: string;
  color?: string;
};

/**
 * Optional presence options for syncLexicalWithDoc.
 * Pass as third argument when you want to sync selection to presence and/or render remote cursors.
 */
export type syncLexicalWithDocPresenceOptions = {
  /** When provided, local selection is synced to presence and remote cursors can be rendered. */
  setPresence?:
    | ((selection: PresenceSelection | undefined) => void)
    | undefined;
  /** When provided, outgoing presence is enriched with name and color. */
  user?: { name: string; color: string } | undefined;
};

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

export const createLexicalDoc = (): Doc => {
  return Doc.fromJSON({ extensions: [{ nodes: [LexicalDocNode] }] }, [
    "01kc52hq510g6y44jhq0wqrjb3",
    "root",
    {},
  ]);
};
