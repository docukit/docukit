"use client";

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { Doc, UndoManager } from "@docukit/docnode";
import { syncLexicalWithDoc } from "../index.js";
import { updatePresence } from "../presence/index.js";
import type { PresenceSelection } from "../types.js";
import type { Presence } from "../presence/types.js";

export type PresenceUser = { name: string; color: string };

export type DocNodePluginProps = {
  doc: Doc;
  presence?: Presence | undefined;
  setPresence?:
    | ((selection: PresenceSelection | undefined) => void)
    | undefined;
  /**
   * User information to attach to presence data.
   * When provided, the plugin will automatically enrich presence updates
   * with the user's name and color.
   */
  user?: PresenceUser | undefined;
  /**
   * UndoManager wired to UNDO_COMMAND/REDO_COMMAND. If omitted, a default
   * one is created. Pass your own to share an UndoManager across editors or
   * to customize options like `maxUndoSteps`.
   */
  undoManager?: UndoManager | undefined;
};

/**
 * Lexical plugin that syncs a DocNode document with the editor.
 * Optionally handles presence (collaborative cursors) if setPresence is provided.
 *
 * Binding runs only when `editor` or `doc` change (by reference), so the cursor is not
 * reset on parent re-renders. Pass stable setPresence/user (e.g. useCallback/useMemo) or
 * key the editor when they change.
 *
 * @example
 * ```tsx
 * import { DocNodePlugin } from "@docukit/docnode-lexical/react";
 *
 * function Editor({ doc, presence, setPresence }) {
 *   return (
 *     <LexicalComposer initialConfig={config}>
 *       <DocNodePlugin doc={doc} presence={presence} setPresence={setPresence} />
 *       <RichTextPlugin ... />
 *     </LexicalComposer>
 *   );
 * }
 * ```
 */
export function DocNodePlugin({
  doc,
  presence,
  setPresence,
  user,
  undoManager,
}: DocNodePluginProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return syncLexicalWithDoc(editor, doc, {
      presence: { setPresence, user },
      undoManager,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, doc]);

  useEffect(() => {
    updatePresence(editor, presence ?? {});
  }, [editor, presence]);

  return null;
}
