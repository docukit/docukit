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

import type {
  LexicalPresence,
  LocalSelection,
  Presence,
} from "./syncPresence.js";

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
 * Optional presence options for docToLexical.
 * Pass as third argument when you want to sync selection to presence and/or render remote cursors.
 */
export type DocToLexicalPresenceOptions = {
  /** When provided, local selection is synced to presence and remote cursors can be rendered. */
  setPresence?:
    | ((selection: LocalSelection | LexicalPresence | undefined) => void)
    | undefined;
  /** When provided, outgoing presence is enriched with name and color. */
  user?: { name: string; color: string } | undefined;
};

/** Result of docToLexical. renderPresence is only present when presence options were passed. */
export type DocToLexicalResult = {
  editor: LexicalEditor;
  doc: Doc;
  keyBinding: KeyBinding;
  cleanup: () => void;
  /** Call when presence data changes to update remote cursors. Only set when presence options were passed. */
  renderPresence?: (presence: Presence) => void;
};

const bindingByEditor = new WeakMap<
  LexicalEditor,
  {
    presenceHandle: ReturnType<typeof syncPresence> | undefined;
    lastPresence: Presence | undefined;
    coreCleanup: () => void;
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
 * Bind a Lexical editor to a DocNode doc. The consumer must create the editor first (e.g. with createEditor from Lexical).
 *
 * @param editor - Lexical editor instance.
 * @param doc - DocNode document. If omitted, a new doc is created.
 * @param presenceOptions - Optional. When setPresence is provided, selection is synced to presence and renderPresence is returned for remote cursors.
 * @returns Result with editor, doc, keyBinding, cleanup, and optional renderPresence.
 */
export function docToLexical(
  editor: LexicalEditor,
  doc?: Doc,
  presenceOptions?: DocToLexicalPresenceOptions,
): DocToLexicalResult {
  const resolvedDoc =
    doc ??
    Doc.fromJSON({ extensions: [{ nodes: [LexicalDocNode] }] }, [
      "01kc52hq510g6y44jhq0wqrjb3",
      "root",
      {},
    ]);
  const core = docToLexicalCore(editor, resolvedDoc);

  const { setPresence: rawSetPresence, user } = presenceOptions ?? {};
  let presenceHandle: ReturnType<typeof syncPresence> | undefined;
  if (rawSetPresence) {
    const setPresence = (selection: LocalSelection | undefined) => {
      if (!selection) {
        rawSetPresence(undefined);
        return;
      }
      if (user?.name !== undefined && user?.color !== undefined) {
        rawSetPresence({ ...selection, name: user.name, color: user.color });
      } else {
        rawSetPresence(selection);
      }
    };
    presenceHandle = syncPresence(editor, core.keyBinding, setPresence);
  }

  bindingByEditor.set(editor, {
    presenceHandle,
    lastPresence: undefined,
    coreCleanup: core.cleanup,
  });

  const cleanup = () => {
    const binding = bindingByEditor.get(editor);
    bindingByEditor.delete(editor);
    binding?.presenceHandle?.cleanup();
    core.cleanup();
  };

  const renderPresence =
    presenceHandle !== undefined
      ? (presence: Presence) => updatePresence(editor, presence)
      : undefined;

  return {
    editor: core.editor,
    doc: core.doc,
    keyBinding: core.keyBinding,
    cleanup,
    ...(renderPresence !== undefined && { renderPresence }),
  };
}

function docToLexicalCore(
  editor: LexicalEditor,
  doc: Doc,
): {
  editor: LexicalEditor;
  doc: Doc;
  keyBinding: KeyBinding;
  cleanup: () => void;
} {
  const lexicalKeyToDocNodeId = new Map<string, string>();
  const docNodeIdToLexicalKey = new Map<string, string>();

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
