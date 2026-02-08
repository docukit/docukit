/**
 * Presence sync for Lexical editor
 * Adapted from @lexical/yjs SyncCursors.ts
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * MIT License
 */

import {
  BLUR_COMMAND,
  COMMAND_PRIORITY_EDITOR,
  FOCUS_COMMAND,
  SELECTION_CHANGE_COMMAND,
  type LexicalEditor,
} from "lexical";
import type {
  KeyBinding,
  PresenceSelection,
  syncLexicalWithDocPresenceOptions,
} from "../types.js";
import { destroyCursor, updateCursor } from "./cursorRendering.js";
import { syncSelectionToPresence } from "./syncSelectionToPresence.js";
import { syncPresenceToSelection } from "./syncPresenceToSelection.js";
import { transformCursorSelection } from "./transformOffset.js";
import type { Presence, PresenceBinding, PresenceHandle } from "./types.js";

/**
 * Sets up presence synchronization between a Lexical editor and a presence system.
 * Returns undefined if no setPresence callback is provided in presenceOptions.
 *
 * @param editor - The Lexical editor instance
 * @param keyBinding - The key mapping from syncLexicalWithDoc for converting between Lexical keys and DocNode IDs
 * @param presenceOptions - Optional presence options. When setPresence is provided, local selection is synced.
 *   When user is provided, outgoing presence is enriched with name and color.
 * @returns A handle with updateRemoteCursors and cleanup functions, or undefined if no setPresence is provided
 */
export function syncPresence(
  editor: LexicalEditor,
  keyBinding: KeyBinding,
  presenceOptions?: syncLexicalWithDocPresenceOptions,
): PresenceHandle | undefined {
  const { setPresence: rawSetPresence, user } = presenceOptions ?? {};
  if (!rawSetPresence) return undefined;

  const setPresence = (selection: PresenceSelection | undefined) =>
    rawSetPresence(
      selection && user?.name != null && user?.color != null
        ? { ...selection, name: user.name, color: user.color }
        : selection,
    );

  const rootElement = editor.getRootElement();
  let cursorsContainer: HTMLElement | undefined;

  if (rootElement) {
    const parent = rootElement.parentElement;
    if (parent) {
      const parentStyle = window.getComputedStyle(parent);
      if (parentStyle.position === "static") {
        parent.style.position = "relative";
      }
      cursorsContainer = document.createElement("div");
      cursorsContainer.style.cssText =
        "position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;overflow:hidden;";
      parent.appendChild(cursorsContainer);
    }
  }

  const binding: PresenceBinding = {
    editor,
    cursorsContainer,
    cursors: new Map(),
    keyBinding,
  };

  const editorHasFocus = (): boolean => {
    const rootElement = editor.getRootElement();
    if (!rootElement) return false;
    return (
      rootElement.contains(document.activeElement) ||
      rootElement === document.activeElement
    );
  };

  const unregisterSelectionListener = editor.registerCommand(
    SELECTION_CHANGE_COMMAND,
    () => {
      if (!editorHasFocus()) return false;
      editor.getEditorState().read(() => {
        syncSelectionToPresence(keyBinding, setPresence);
      });
      return false;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const unregisterFocusListener = editor.registerCommand(
    FOCUS_COMMAND,
    () => {
      editor.getEditorState().read(() => {
        syncSelectionToPresence(keyBinding, setPresence);
      });
      return false;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const unregisterBlurListener = editor.registerCommand(
    BLUR_COMMAND,
    () => {
      if (!editorHasFocus()) setPresence(undefined);
      return false;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const unregisterUpdateListener = editor.registerUpdateListener(
    ({ editorState, prevEditorState, dirtyLeaves }) => {
      if (dirtyLeaves.size === 0) return;
      if (binding.cursors.size === 0) return;

      let anyTransformed = false;
      for (const cursor of binding.cursors.values()) {
        if (!cursor.selection) continue;
        if (
          transformCursorSelection(
            cursor.selection,
            dirtyLeaves,
            prevEditorState,
            editorState,
          )
        ) {
          anyTransformed = true;
        }
      }

      if (anyTransformed) {
        const nodeMap = editorState._nodeMap;
        for (const cursor of binding.cursors.values()) {
          updateCursor(binding, cursor, cursor.selection, nodeMap);
        }
      }
    },
  );

  return {
    updateRemoteCursors: (presence: Presence) => {
      syncPresenceToSelection(binding, presence);
    },
    cleanup: () => {
      unregisterSelectionListener();
      unregisterFocusListener();
      unregisterBlurListener();
      unregisterUpdateListener();
      for (const cursor of binding.cursors.values()) {
        destroyCursor(binding, cursor);
      }
      binding.cursors.clear();
      if (cursorsContainer?.parentElement) {
        cursorsContainer.parentElement.removeChild(cursorsContainer);
      }
    },
  };
}
