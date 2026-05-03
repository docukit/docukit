import { UndoManager, type Doc } from "@docukit/docnode";
import {
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_HIGH,
  REDO_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
} from "lexical";

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

/**
 * @internal - Do not use this function!
 */
export function syncUndoManager(
  editor: LexicalEditor,
  doc: Doc,
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

  // Initial dispatch so toolbars reflect the cached UndoManager's state
  // immediately (e.g. after a remount where the cached default already has
  // undo history).
  dispatchCanCommands();
  const offChange = doc.onChange(dispatchCanCommands);

  const offUndo = editor.registerCommand(
    UNDO_COMMAND,
    () => {
      if (undoManager.canUndo()) undoManager.undo();
      return true;
    },
    // Runs at COMMAND_PRIORITY_HIGH so it intercepts
    // Lexical's HistoryPlugin if the consumer mounts it.
    COMMAND_PRIORITY_HIGH,
  );

  const offRedo = editor.registerCommand(
    REDO_COMMAND,
    () => {
      if (undoManager.canRedo()) undoManager.redo();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );

  return () => {
    offUndo();
    offRedo();
    offChange();
  };
}
