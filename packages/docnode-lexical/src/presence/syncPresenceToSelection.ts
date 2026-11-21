import {
  createCursor,
  createCursorSelection,
  destroyCursor,
  updateCursor,
} from "./cursorRendering.js";
import type { Presence, PresenceBinding } from "./types.js";

/**
 * Takes incoming presence from other users, maps their cursor ends to local
 * Lexical points, and creates/updates/removes the cursor DOM for each remote user.
 */
export function syncPresenceToSelection(
  binding: PresenceBinding,
  presence: Presence,
): void {
  const { editor, cursors, points } = binding;
  const nodeMap = editor._editorState._nodeMap;
  const visitedUserIds = new Set<string>();

  for (const [userId, userPresence] of Object.entries(presence)) {
    if (!userPresence) continue;

    visitedUserIds.add(userId);

    const { name, color, anchor, focus } = userPresence;

    const resolved = editor
      .getEditorState()
      .read(() => ({
        anchor: points.$remote(anchor),
        focus: points.$remote(focus),
      }));
    if (!resolved.anchor || !resolved.focus) {
      // Not in this editor (yet): no cursor where it was either
      const cursor = cursors.get(userId);
      if (cursor) updateCursor(binding, cursor, undefined, nodeMap);
      continue;
    }
    const anchorLexicalKey = resolved.anchor.key;
    const focusLexicalKey = resolved.focus.key;

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
          resolved.anchor.offset,
          focusLexicalKey,
          resolved.focus.offset,
        );
      } else {
        // Update existing selection with converted keys
        selection.anchor.key = anchorLexicalKey;
        selection.anchor.offset = resolved.anchor.offset;
        selection.focus.key = focusLexicalKey;
        selection.focus.offset = resolved.focus.offset;
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
