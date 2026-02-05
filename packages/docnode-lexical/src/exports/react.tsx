"use client";

import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { Doc } from "docnode";
import {
  docToLexical,
  syncPresence,
  type LocalSelection,
  type Presence,
} from "../index.js";

export type { LocalSelection, Presence } from "../index.js";

export type DocNodePluginProps = {
  doc: Doc;
  presence?: Presence | undefined;
  setPresence?: ((selection: LocalSelection | undefined) => void) | undefined;
};

/**
 * Lexical plugin that syncs a DocNode document with the editor.
 * Optionally handles presence (collaborative cursors) if setPresence is provided.
 *
 * @example
 * ```tsx
 * import { DocNodePlugin } from "@docnode/lexical/react";
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
  setPresence,
}: DocNodePluginProps) {
  const [editor] = useLexicalComposerContext();
  const presenceHandleRef = useRef<ReturnType<typeof syncPresence> | undefined>(
    undefined,
  );

  // Set up doc sync and presence together (they share keyBinding)
  useEffect(() => {
    if (!doc) return;
    const { cleanup, keyBinding } = docToLexical(editor, doc);

    // Set up presence if setPresence is available
    if (setPresence) {
      presenceHandleRef.current = syncPresence(editor, keyBinding, setPresence);
    }

    return () => {
      presenceHandleRef.current?.cleanup();
      presenceHandleRef.current = undefined;
      cleanup();
    };
  }, [editor, doc, setPresence]);

  // Update remote cursors when presence changes
  useEffect(() => {
    if (presence && presenceHandleRef.current) {
      presenceHandleRef.current.updateRemoteCursors(presence);
    }
  }, [presence]);

  return null;
}
