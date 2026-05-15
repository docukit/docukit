import { type Doc } from "./main.js";
import type { Operations } from "./operations.js";

/** `meta` is opaque — consumers attach arbitrary data (e.g. selection). */
export type UndoStackItem = {
  operations: Operations;
  meta: Map<unknown, unknown>;
};

export type UndoManagerEvent = { item: UndoStackItem; type: "undo" | "redo" };

type Handler = (event: UndoManagerEvent) => void;

export class UndoManager {
  private readonly _doc: Doc;
  private readonly _maxUndoSteps: number;
  protected _undoStack: UndoStackItem[] = [];
  protected _redoStack: UndoStackItem[] = [];
  private _txType: "undo" | "redo" | "update" = "update";
  private _lastUpdate?: number; // TODO: threeshold to combine transactions of 500ms
  private _pushHandlers = new Set<Handler>();
  private _popHandlers = new Set<Handler>();

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
      const item: UndoStackItem = {
        operations: event.inverseOperations,
        meta: new Map(),
      };
      if (this._txType === "update") {
        if (this._maxUndoSteps > this._undoStack.length) {
          this._undoStack.push(item);
          this._pushHandlers.forEach((h) => h({ item, type: "undo" }));
        }
        this._redoStack = [];
        this._lastUpdate = Date.now();
      } else if (this._txType === "undo") {
        this._redoStack.push(item);
        this._txType = "update";
        this._pushHandlers.forEach((h) => h({ item, type: "redo" }));
      } else {
        this._undoStack.push(item);
        this._txType = "update";
        this._pushHandlers.forEach((h) => h({ item, type: "undo" }));
      }
    });
  }

  undo() {
    this._doc.forceCommit();
    this._txType = "undo";
    const item = this._undoStack.pop();
    if (!item) return;
    this._doc.applyOperations(item.operations);
    this._popHandlers.forEach((h) => h({ item, type: "undo" }));
  }

  redo() {
    this._doc.forceCommit();
    this._txType = "redo";
    const item = this._redoStack.pop();
    if (!item) return;
    this._doc.applyOperations(item.operations);
    this._popHandlers.forEach((h) => h({ item, type: "redo" }));
  }

  canUndo() {
    return this._undoStack.length > 0;
  }

  canRedo() {
    return this._redoStack.length > 0;
  }

  /** Fires synchronously when an item is pushed to either stack. */
  onPush(handler: Handler): () => void {
    this._pushHandlers.add(handler);
    return () => {
      this._pushHandlers.delete(handler);
    };
  }

  /** Fires synchronously after `applyOperations` returns on undo/redo. */
  onPop(handler: Handler): () => void {
    this._popHandlers.add(handler);
    return () => {
      this._popHandlers.delete(handler);
    };
  }
}
