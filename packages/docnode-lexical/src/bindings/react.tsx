"use client";

import { useCallback, useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { Doc } from "@docukit/docnode";
import {
  docToLexical,
  syncPresence,
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
// TODO: The docnode-lexical core should do more, and bindings like this should be much simpler.
export function DocNodePlugin({
  doc,
  presence,
  setPresence: rawSetPresence,
  user,
}: DocNodePluginProps) {
  const [editor] = useLexicalComposerContext();
  const presenceHandleRef = useRef<ReturnType<typeof syncPresence> | undefined>(
    undefined,
  );

  // Extract primitive values to avoid re-creating callback when user object reference changes
  const userName = user?.name;
  const userColor = user?.color;

  // Wrap setPresence to include user info when provided
  const setPresence = useCallback(
    (selection: LocalSelection | undefined) => {
      if (!rawSetPresence) return;
      if (!selection) {
        rawSetPresence(undefined);
        return;
      }
      // Enrich with user info if provided
      if (userName !== undefined && userColor !== undefined) {
        rawSetPresence({
          ...selection,
          name: userName,
          color: userColor,
        });
      } else {
        rawSetPresence(selection);
      }
    },
    [rawSetPresence, userName, userColor],
  );

  // Set up doc sync and presence together (they share keyBinding)
  useEffect(() => {
    if (!doc) return;
    const { cleanup, keyBinding } = docToLexical(editor, doc);

    // Set up presence if setPresence is available
    if (rawSetPresence) {
      presenceHandleRef.current = syncPresence(editor, keyBinding, setPresence);
    }

    return () => {
      presenceHandleRef.current?.cleanup();
      presenceHandleRef.current = undefined;
      cleanup();
    };
  }, [editor, doc, rawSetPresence, setPresence]);

  // Update remote cursors when presence changes
  useEffect(() => {
    if (presence && presenceHandleRef.current) {
      presenceHandleRef.current.updateRemoteCursors(presence);
    }
  }, [presence]);

  return null;
}
