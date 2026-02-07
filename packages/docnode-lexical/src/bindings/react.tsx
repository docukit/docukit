"use client";

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { Doc } from "@docukit/docnode";
import {
  docToLexical,
  updatePresence,
  type LexicalPresence,
  type LocalSelection,
  type Presence,
} from "../index.js";

export type { LexicalPresence, LocalSelection, Presence } from "../index.js";

export type PresenceUser = {
  name: string;
  color: string;
};

/** Selection data that can be sent via setPresence (LocalSelection or enriched with user info) */
export type PresenceSelection = LocalSelection | LexicalPresence;

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
}: DocNodePluginProps) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!doc) return;
    const presenceOptions =
      setPresence != null
        ? { setPresence, ...(user != null && { user }) }
        : undefined;
    const { cleanup } = docToLexical(editor, doc, presenceOptions);
    return cleanup;
    // Intentionally only [editor, doc]: avoid re-binding on re-renders so cursor does not jump.
  }, [editor, doc]);

  useEffect(() => {
    updatePresence(editor, presence ?? {});
  }, [editor, presence]);

  return null;
}
