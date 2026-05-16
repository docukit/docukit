import { UndoManager, type Doc } from "@docukit/docnode";
import {
  $createRangeSelection,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  BLUR_COMMAND,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_HIGH,
  REDO_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
} from "lexical";

import type { KeyBinding, PresenceSelection } from "./types.js";

/**
 * One default UndoManager per Doc. Memoizing here means the editor's undo
 * history survives mount/unmount/remount cycles (StrictMode, HMR, route
 * changes that keep the Doc alive) instead of being recreated and leaking the
 * previous one in `doc._changeListeners`. The entry is GC'd when the Doc is
 * GC'd. Users who want a dedicated UndoManager pass one via the third
 * argument and bypass this cache.
 */
const defaultUndoManagers = new WeakMap<Doc, UndoManager>();

function getDefaultUndoManager(doc: Doc): UndoManager {
  let undoManager = defaultUndoManagers.get(doc);
  if (!undoManager) {
    undoManager = new UndoManager(doc);
    defaultUndoManagers.set(doc, undoManager);
  }
  return undoManager;
}

const META_SELECTION = "selection";

/**
 * @internal - Do not use this function!
 */
export function syncUndoManager(
  editor: LexicalEditor,
  doc: Doc,
  keyBinding: KeyBinding,
  undoManager: UndoManager = getDefaultUndoManager(doc),
): () => void {
  // Track previous values so we only dispatch on transitions, mirroring
  // Lexical's own history plugin (lexical-history dispatches CAN_*_COMMAND
  // only when the boolean changes, not on every editor update).
  let prevCanUndo: boolean | undefined;
  let prevCanRedo: boolean | undefined;

  const dispatchCanCommands = () => {
    const canUndo = undoManager.canUndo();
    const canRedo = undoManager.canRedo();
    if (canUndo !== prevCanUndo) {
      editor.dispatchCommand(CAN_UNDO_COMMAND, canUndo);
      prevCanUndo = canUndo;
    }
    if (canRedo !== prevCanRedo) {
      editor.dispatchCommand(CAN_REDO_COMMAND, canRedo);
      prevCanRedo = canRedo;
    }
  };

  dispatchCanCommands();
  const offChange = doc.onChange(dispatchCanCommands);

  // Selection captured by one source (update listener / UNDO_COMMAND /
  // REDO_COMMAND), waiting to be consumed by the next `onPush`. `targetStack`
  // says which stack the captured selection should attach to so the `onPush`
  // handler can match it against the event's `type` and ignore mismatches.
  let pending:
    | { targetStack: "undo" | "redo"; selection: PresenceSelection | undefined }
    | undefined;

  const offUpdate = editor.registerUpdateListener(
    ({ prevEditorState, dirtyElements, dirtyLeaves, tags }) => {
      if (tags.has(COLLABORATION_TAG)) return;
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      pending = {
        targetStack: "undo",
        selection: prevEditorState.read(() => captureSelection(keyBinding)),
      };
    },
  );

  const offBlur = editor.registerCommand(
    BLUR_COMMAND,
    () => {
      pending = undefined;
      return false;
    },
    COMMAND_PRIORITY_EDITOR,
  );

  const offPush = undoManager.onPush(({ item, type }) => {
    if (pending?.targetStack === type && pending.selection) {
      item.meta.set(META_SELECTION, pending.selection);
    }
    pending = undefined;
  });

  const offPop = undoManager.onPop(({ item }) => {
    const selection = item.meta.get(META_SELECTION) as
      | PresenceSelection
      | undefined;
    if (!selection) return;
    editor.update(
      () => {
        restoreSelection(selection, keyBinding, doc);
      },
      // No content change here; tag suppresses the update-listener so we
      // don't accidentally treat this as a local edit.
      { discrete: true, tag: COLLABORATION_TAG },
    );
  });

  const offUndo = editor.registerCommand(
    UNDO_COMMAND,
    () => {
      if (!undoManager.canUndo()) return false;
      pending = {
        targetStack: "redo",
        selection: captureSelection(keyBinding),
      };
      undoManager.undo();
      return true;
    },
    // Runs at COMMAND_PRIORITY_HIGH so it intercepts
    // Lexical's HistoryPlugin if the consumer mounts it.
    COMMAND_PRIORITY_HIGH,
  );

  const offRedo = editor.registerCommand(
    REDO_COMMAND,
    () => {
      if (!undoManager.canRedo()) return false;
      pending = {
        targetStack: "undo",
        selection: captureSelection(keyBinding),
      };
      undoManager.redo();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );

  if (process.env.NODE_ENV !== "production") {
    warnIfHistoryPluginActive(editor);
  }

  return () => {
    offUndo();
    offRedo();
    offChange();
    offUpdate();
    offBlur();
    offPush();
    offPop();
  };
}

/** Reads the current Lexical selection as DocNode-ID-based stable positions. */
function captureSelection(
  keyBinding: KeyBinding,
): PresenceSelection | undefined {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return undefined;
  const anchorId = keyBinding.lexicalKeyToDocNodeId.get(sel.anchor.key);
  const focusId = keyBinding.lexicalKeyToDocNodeId.get(sel.focus.key);
  if (!anchorId || !focusId) return undefined;
  return {
    anchor: { key: anchorId, offset: sel.anchor.offset },
    focus: { key: focusId, offset: sel.focus.offset },
  };
}

type ResolvedPoint = { key: string; offset: number; type: "text" | "element" };

/**
 * Resolves a saved endpoint (`{ key, offset }` from `PresenceSelection`) to a
 * live Lexical position. Returns `null` when nothing usable can be found.
 *
 * 1. Direct lookup: if the docNodeId is still mapped, use it (clamping the
 *    offset for text nodes).
 * 2. If the node was deleted, walk the DocNode tree `prev sibling → parent`
 *    looking for the closest still-mapped neighbor (matches lexical-yjs's
 *    `$moveSelectionToPreviousNode` strategy from
 *    `lexical/packages/lexical-yjs/src/Utils.ts`, but on DocNode IDs because
 *    the Lexical node is already gone by the time we restore).
 * 3. Last resort: caller falls back to root.start.
 */
function $resolveEndpoint(
  endpoint: { key: string; offset: number },
  keyBinding: KeyBinding,
  doc: Doc,
): ResolvedPoint | undefined {
  const lexicalKey = keyBinding.docNodeIdToLexicalKey.get(endpoint.key);
  if (lexicalKey) {
    const node = $getNodeByKey(lexicalKey);
    if (node?.isAttached()) {
      if ($isTextNode(node)) {
        return {
          key: lexicalKey,
          offset: Math.min(endpoint.offset, node.getTextContentSize()),
          type: "text",
        };
      }
      return { key: lexicalKey, offset: endpoint.offset, type: "element" };
    }
  }

  const tryNeighbor = (docNodeId: string): ResolvedPoint | undefined => {
    const k = keyBinding.docNodeIdToLexicalKey.get(docNodeId);
    if (!k) return undefined;
    const n = $getNodeByKey(k);
    if (!n?.isAttached() || !$isElementNode(n)) return undefined;
    return { key: k, offset: n.getChildrenSize(), type: "element" };
  };

  const docNode = doc.getNodeById(endpoint.key);
  if (docNode) {
    let prev = docNode.prev;
    while (prev) {
      const r = tryNeighbor(prev.id);
      if (r) return r;
      prev = prev.prev;
    }
    if (docNode.parent) {
      const r = tryNeighbor(docNode.parent.id);
      if (r) return r;
    }
  }
  return undefined;
}

/**
 * Resolves DocNode IDs back to Lexical keys and applies the selection.
 * Anchor and focus are resolved independently — when one endpoint's node was
 * concurrently deleted but the other still exists, we collapse to the
 * surviving side rather than dropping the entire selection. When both
 * resolve, the original range is preserved (with whatever survived in
 * between). When neither resolves, fall back to root.start.
 */
function restoreSelection(
  presence: PresenceSelection,
  keyBinding: KeyBinding,
  doc: Doc,
): void {
  const anchorPoint = $resolveEndpoint(presence.anchor, keyBinding, doc);
  const focusPoint = $resolveEndpoint(presence.focus, keyBinding, doc);

  if (!anchorPoint && !focusPoint) {
    $getRoot().selectStart();
    return;
  }

  // Collapse to the surviving side if only one endpoint resolved.
  const finalAnchor = anchorPoint ?? focusPoint!;
  const finalFocus = focusPoint ?? anchorPoint!;

  const sel = $createRangeSelection();
  sel.anchor.set(finalAnchor.key, finalAnchor.offset, finalAnchor.type);
  sel.focus.set(finalFocus.key, finalFocus.offset, finalFocus.type);
  $setSelection(sel);
}

function warnIfHistoryPluginActive(editor: LexicalEditor): void {
  queueMicrotask(() => {
    const undoListeners = editor._commands.get(UNDO_COMMAND);
    if ((undoListeners?.[COMMAND_PRIORITY_EDITOR]?.size ?? 0) > 0) {
      console.warn(
        "[docnode-lexical] Another UNDO_COMMAND handler detected (likely " +
          "<HistoryPlugin />). Remove it — DocNode's delta-based undo is " +
          "already wired; the duplicate keeps a full-snapshot history in " +
          "memory unnecessarily.",
      );
    }
  });
}
