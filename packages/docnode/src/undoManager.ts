import { type Doc } from "./main.js";
import type { Operations } from "./operations.js";

type UndoStackItem = { operations: Operations };

export class UndoManager {
  private readonly _doc: Doc;
  private readonly _maxUndoSteps: number;
  protected _undoStack: UndoStackItem[] = [];
  protected _redoStack: UndoStackItem[] = [];
  private _txType: "undo" | "redo" | "update" = "update";
  private _lastUpdate?: number; // TODO: threeshold to combine transactions of 500ms

  constructor(
    doc: Doc,
    options?: {
      /**
       * The maximum number of undo steps to keep in the undo stack.
       * If the number of undo steps exceeds this limit, the oldest undo step will be removed.
       * @default 100
       */
      maxUndoSteps?: number;
      // TODO:
      // /**
      //  * The interval in milliseconds to merge transactions into a single undo step.
      //  * @default 1000
      //  */
      // mergeInterval?: number;
    },
  ) {
    this._doc = doc;
    this._maxUndoSteps = options?.maxUndoSteps ?? 100;
    this._doc.onChange((event) => {
      if (event.origin?.startsWith("remote")) return;
      const item: UndoStackItem = { operations: event.inverseOperations };
      if (this._txType === "update") {
        if (this._maxUndoSteps > this._undoStack.length)
          this._undoStack.push(item);
        this._redoStack = [];
        this._lastUpdate = Date.now();
      } else if (this._txType === "undo") {
        this._redoStack.push(item);
        this._txType = "update";
      } else {
        this._undoStack.push(item);
        this._txType = "update";
      }
    });
  }

  undo() {
    this._doc.forceCommit();
    this._txType = "undo";
    const item = this._undoStack.pop();
    if (!item) return;
    this._doc.applyOperations(item.operations);
  }

  redo() {
    this._doc.forceCommit();
    this._txType = "redo";
    const item = this._redoStack.pop();
    if (!item) return;
    this._doc.applyOperations(item.operations);
  }

  canUndo() {
    return this._undoStack.length > 0;
  }

  canRedo() {
    return this._redoStack.length > 0;
  }
}
