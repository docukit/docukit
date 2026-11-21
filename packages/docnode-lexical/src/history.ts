import { type Doc } from "@docukit/docnode";
import {
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

import { SKIP_UNDO_TAG } from "./constants.js";

const META_SELECTION = "selection";

/**
 * Wires Lexical's undo and redo to the document's undo manager, and keeps
 * with each history item the selection before it, as `$capture` reads it:
 * `$restore` puts it back when an undo or redo applies the item.
 */
export function setupHistory<Selection>(
  editor: LexicalEditor,
  doc: Doc,
  $capture: () => Selection | undefined,
  $restore: (selection: Selection) => void,
): () => void {
  const undoManager = doc.undoManager;

  if (process.env.NODE_ENV !== "production") {
    warnIfHistoryPluginActive(editor);
  }

  if (!undoManager.isEnabled) {
    return () => undefined;
  }

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
    | { targetStack: "undo" | "redo"; selection: Selection | undefined }
    | undefined;

  const offUpdate = editor.registerUpdateListener(
    ({ prevEditorState, dirtyElements, dirtyLeaves, tags }) => {
      if (tags.has(COLLABORATION_TAG)) return;
      if (tags.has(SKIP_UNDO_TAG)) return;
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
      pending = {
        targetStack: "undo",
        selection: prevEditorState.read($capture),
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

  const offPush = undoManager.onPush(({ meta, type }) => {
    if (
      pending?.targetStack === type &&
      pending.selection &&
      !meta.has(META_SELECTION)
    ) {
      meta.set(META_SELECTION, pending.selection);
    }
    pending = undefined;
  });

  const offPop = undoManager.onPop(({ meta }) => {
    const selection = meta.get(META_SELECTION) as Selection | undefined;
    if (!selection) return;
    editor.update(
      () => {
        $restore(selection);
      },
      // Only the selection changes, which the update listeners ignore. No tag:
      // Lexical keeps the tags of an update without dirty nodes for the next
      // one, so the user's next keystroke would look remote and be dropped.
      { discrete: true },
    );
  });

  const offUndo = editor.registerCommand(
    UNDO_COMMAND,
    () => {
      if (!undoManager.canUndo()) return false;
      pending = { targetStack: "redo", selection: $capture() };
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
      pending = { targetStack: "undo", selection: $capture() };
      undoManager.redo();
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );

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

function warnIfHistoryPluginActive(editor: LexicalEditor): void {
  queueMicrotask(() => {
    const undoListeners = editor._commands.get(UNDO_COMMAND);
    if ((undoListeners?.[COMMAND_PRIORITY_EDITOR]?.size ?? 0) > 0) {
      console.warn(
        "[docnode-lexical] Another UNDO_COMMAND handler detected (likely " +
          "<HistoryPlugin />). Remove it and instead enable DocNode's " +
          "undoManager, which ignores remote operations, is more reliable " +
          "for collaborative edits, and consumes less memory because it only " +
          "stores deltas and not full snapshots.",
      );
    }
  });
}
