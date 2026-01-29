/**
 * Presence sync for Lexical editor
 * Adapted from @lexical/yjs SyncCursors.ts
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * MIT License
 */

import { createDOMRange, createRectsFromDOMRange } from "@lexical/selection";
import {
  $getNodeByKey,
  $getSelection,
  $isLineBreakNode,
  $isRangeSelection,
  type LexicalEditor,
  type NodeKey,
  type NodeMap,
} from "lexical";
import type { KeyBinding } from "./index.js";

/** Selection data for the local user (sent via setPresence, uses DocNode IDs) */
export type LocalSelection = {
  anchor: { key: string; offset: number };
  focus: { key: string; offset: number };
};

/** Presence data for a remote user (uses DocNode IDs, includes name and color for rendering) */
export type LexicalPresence = {
  anchor: { key: string; offset: number };
  focus: { key: string; offset: number };
  name: string;
  color: string;
};

/** Map of socket IDs to their presence data (excludes the current user) */
export type Presence = Record<string, LexicalPresence>;

// Internal types for cursor rendering
type CursorSelection = {
  anchor: { key: NodeKey; offset: number };
  focus: { key: NodeKey; offset: number };
  caret: HTMLElement;
  color: string;
  name: HTMLSpanElement;
  selections: HTMLElement[];
};

type Cursor = {
  color: string;
  name: string;
  selection: CursorSelection | undefined;
};

type PresenceBinding = {
  editor: LexicalEditor;
  cursorsContainer: HTMLElement | undefined;
  cursors: Map<string, Cursor>;
  keyBinding: KeyBinding;
};

function createCursor(name: string, color: string): Cursor {
  return {
    color,
    name,
    selection: undefined,
  };
}

function destroySelection(
  binding: PresenceBinding,
  selection: CursorSelection,
) {
  const cursorsContainer = binding.cursorsContainer;
  if (cursorsContainer) {
    for (const sel of selection.selections) {
      cursorsContainer.removeChild(sel);
    }
  }
}

function destroyCursor(binding: PresenceBinding, cursor: Cursor) {
  if (cursor.selection) {
    destroySelection(binding, cursor.selection);
  }
}

function createCursorSelection(
  cursor: Cursor,
  anchorKey: NodeKey,
  anchorOffset: number,
  focusKey: NodeKey,
  focusOffset: number,
): CursorSelection {
  const { color } = cursor;

  // Create caret element (the vertical line)
  const caret = document.createElement("span");
  caret.style.cssText = `position:absolute;top:0;bottom:0;right:-1px;width:2px;background-color:${color};z-index:10;`;

  // Create name label
  const name = document.createElement("span");
  name.textContent = cursor.name;
  name.style.cssText = `position:absolute;left:-2px;top:-18px;background-color:${color};color:#fff;line-height:12px;font-size:11px;padding:2px 4px;font-family:system-ui,sans-serif;font-weight:500;white-space:nowrap;border-radius:2px;pointer-events:none;`;
  caret.appendChild(name);

  return {
    anchor: { key: anchorKey, offset: anchorOffset },
    focus: { key: focusKey, offset: focusOffset },
    caret,
    color,
    name,
    selections: [],
  };
}

function updateCursor(
  binding: PresenceBinding,
  cursor: Cursor,
  nextSelection: CursorSelection | undefined,
  nodeMap: NodeMap,
): void {
  const { editor, cursorsContainer } = binding;
  const rootElement = editor.getRootElement();

  if (!cursorsContainer || !rootElement) return;

  const cursorsContainerOffsetParent = cursorsContainer.offsetParent;
  if (!cursorsContainerOffsetParent) return;

  const containerRect = cursorsContainerOffsetParent.getBoundingClientRect();
  const prevSelection = cursor.selection;

  if (!nextSelection) {
    if (prevSelection) {
      cursor.selection = undefined;
      destroySelection(binding, prevSelection);
    }
    return;
  }

  cursor.selection = nextSelection;

  const { caret, color, selections, anchor, focus } = nextSelection;
  const anchorNode = nodeMap.get(anchor.key);
  const focusNode = nodeMap.get(focus.key);

  if (!anchorNode || !focusNode) return;

  let selectionRects: DOMRect[];

  // Handle collapsed selection on linebreak (browsers return nothing for <br>)
  if (anchorNode === focusNode && $isLineBreakNode(anchorNode)) {
    const brElement = editor.getElementByKey(anchor.key)!;
    selectionRects = [brElement.getBoundingClientRect()];
  } else {
    const range = createDOMRange(
      editor,
      anchorNode,
      anchor.offset,
      focusNode,
      focus.offset,
    );

    if (!range) {
      return;
    }
    selectionRects = createRectsFromDOMRange(editor, range);
  }

  const selectionsLength = selections.length;
  const selectionRectsLength = selectionRects.length;

  // Create/update selection highlight spans
  for (let i = 0; i < selectionRectsLength; i++) {
    const selectionRect = selectionRects[i];
    if (!selectionRect) continue;

    let selection = selections[i];

    if (!selection) {
      selection = document.createElement("span");
      selections[i] = selection;
      const selectionBg = document.createElement("span");
      selection.appendChild(selectionBg);
      cursorsContainer.appendChild(selection);
    }

    const top = selectionRect.top - containerRect.top;
    const left = selectionRect.left - containerRect.left;
    const style = `position:absolute;top:${top}px;left:${left}px;height:${selectionRect.height}px;width:${selectionRect.width}px;pointer-events:none;z-index:5;`;
    selection.style.cssText = style;

    (selection.firstChild as HTMLSpanElement).style.cssText =
      `${style}left:0;top:0;background-color:${color};opacity:0.3;`;

    // Append caret to the last selection rect
    if (i === selectionRectsLength - 1) {
      if (caret.parentNode !== selection) {
        selection.appendChild(caret);
      }
    }
  }

  // Remove extra selection spans
  for (let i = selectionsLength - 1; i >= selectionRectsLength; i--) {
    const selection = selections[i];
    if (selection) {
      cursorsContainer.removeChild(selection);
    }
    selections.pop();
  }
}

function syncRemoteCursors(binding: PresenceBinding, presence: Presence): void {
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

    let selection: CursorSelection | undefined;

    if (anchor && focus) {
      selection = cursor.selection;

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

function syncLocalSelectionToPresence(
  editor: LexicalEditor,
  keyBinding: KeyBinding,
  setPresence: (selection: LocalSelection | undefined) => void,
): void {
  const selection = $getSelection();

  if (!$isRangeSelection(selection)) {
    setPresence(undefined);
    return;
  }

  const { anchor, focus } = selection;

  // Ensure nodes exist
  const anchorNode = $getNodeByKey(anchor.key);
  const focusNode = $getNodeByKey(focus.key);

  if (!anchorNode || !focusNode) {
    setPresence(undefined);
    return;
  }

  // Convert Lexical keys to DocNode IDs for cross-client compatibility
  const anchorDocNodeId = keyBinding.lexicalKeyToDocNodeId.get(anchor.key);
  const focusDocNodeId = keyBinding.lexicalKeyToDocNodeId.get(focus.key);

  if (!anchorDocNodeId || !focusDocNodeId) {
    // Node not yet mapped (e.g., newly created), skip
    return;
  }

  setPresence({
    anchor: { key: anchorDocNodeId, offset: anchor.offset },
    focus: { key: focusDocNodeId, offset: focus.offset },
  });
}

export type PresenceHandle = {
  /** Call this function when presence changes to update remote cursors */
  updateRemoteCursors: (presence: Presence) => void;
  /** Call this to clean up all listeners and DOM elements */
  cleanup: () => void;
};

/**
 * Sets up presence synchronization between a Lexical editor and a presence system.
 *
 * @param editor - The Lexical editor instance
 * @param keyBinding - The key mapping from docToLexical for converting between Lexical keys and DocNode IDs
 * @param setPresence - Callback invoked when local selection changes (sends selection data only)
 * @returns A handle with updateRemoteCursors and cleanup functions
 *
 * @example
 * ```tsx
 * function PresencePlugin({ presence, setPresence, keyBinding }) {
 *   const [editor] = useLexicalComposerContext();
 *   const handleRef = useRef<PresenceHandle>();
 *
 *   useEffect(() => {
 *     handleRef.current = syncPresence(editor, keyBinding, setPresence);
 *     return () => handleRef.current?.cleanup();
 *   }, [editor, keyBinding, setPresence]);
 *
 *   useEffect(() => {
 *     handleRef.current?.updateRemoteCursors(presence);
 *   }, [presence]);
 *
 *   return null;
 * }
 * ```
 */
export function syncPresence(
  editor: LexicalEditor,
  keyBinding: KeyBinding,
  setPresence: (selection: LocalSelection | undefined) => void,
): PresenceHandle {
  // Create cursors container
  const rootElement = editor.getRootElement();
  let cursorsContainer: HTMLElement | undefined;

  if (rootElement) {
    const parent = rootElement.parentElement;
    if (parent) {
      // Ensure parent has relative positioning for absolute children
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

  // Listen for selection changes to update local presence
  const unregisterSelectionListener = editor.registerUpdateListener(
    ({ editorState, tags }) => {
      // Skip updates from collaboration to avoid loops
      if (tags.has("collaboration")) {
        return;
      }

      editorState.read(() => {
        syncLocalSelectionToPresence(editor, keyBinding, setPresence);
      });
    },
  );

  return {
    updateRemoteCursors: (presence: Presence) => {
      syncRemoteCursors(binding, presence);
    },
    cleanup: () => {
      unregisterSelectionListener();

      // Clean up all cursors
      for (const cursor of binding.cursors.values()) {
        destroyCursor(binding, cursor);
      }
      binding.cursors.clear();

      // Remove cursors container
      if (cursorsContainer?.parentElement) {
        cursorsContainer.parentElement.removeChild(cursorsContainer);
      }
    },
  };
}
