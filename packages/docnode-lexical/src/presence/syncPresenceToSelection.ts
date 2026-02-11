import {
  createCursor,
  createCursorSelection,
  destroyCursor,
  updateCursor,
} from "./cursorRendering.js";
import type { Presence, PresenceBinding } from "./types.js";

/**
 * Takes incoming presence from other users, maps their DocNode IDs to local
 * Lexical keys, and creates/updates/removes the cursor DOM for each remote user.
 */
export function syncPresenceToSelection(
  binding: PresenceBinding,
  presence: Presence,
): void {
  const { editor, cursors, keyBinding } = binding;
  const nodeMap = editor._editorState._nodeMap;
  const visitedUserIds = new Set<string>();

  for (const [userId, userPresence] of Object.entries(presence)) {
    if (!userPresence) continue;

    visitedUserIds.add(userId);

    const { name, color, anchor, focus } = userPresence;

    // Convert DocNode IDs to local Lexical keys
    const anchorLexicalKey = keyBinding.docNodeIdToLexicalKey.get(anchor.key);
    const focusLexicalKey = keyBinding.docNodeIdToLexicalKey.get(focus.key);

    if (!anchorLexicalKey || !focusLexicalKey) {
      // Node not yet mapped in this editor, skip this cursor
      continue;
    }

    let cursor = cursors.get(userId);

    if (!cursor) {
      cursor = createCursor(name, color);
      cursors.set(userId, cursor);
    }

    let selection = cursor.selection;

    if (anchor && focus) {
      if (!selection) {
        selection = createCursorSelection(
          cursor,
          anchorLexicalKey,
          anchor.offset,
          focusLexicalKey,
          focus.offset,
        );
      } else {
        // Update existing selection with converted keys
        selection.anchor.key = anchorLexicalKey;
        selection.anchor.offset = anchor.offset;
        selection.focus.key = focusLexicalKey;
        selection.focus.offset = focus.offset;
      }
    } else {
      selection = undefined;
    }

    updateCursor(binding, cursor, selection, nodeMap);
  }

  // Clean up cursors for users no longer in presence
  for (const [userId, cursor] of cursors) {
    if (!visitedUserIds.has(userId)) {
      destroyCursor(binding, cursor);
      cursors.delete(userId);
    }
  }
}
