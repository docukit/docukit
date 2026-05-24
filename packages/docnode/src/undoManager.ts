import { type Doc } from "./main.js";
import type { Operations } from "./operations.js";
import type { UndoManagerConfig } from "./types.js";

/** `meta` is opaque — consumers attach arbitrary data (e.g. selection). */
type UndoStackItem = { operations: Operations; meta: Map<string, unknown> };

type UndoManagerEvent = { meta: UndoStackItem["meta"]; type: "undo" | "redo" };

type Handler = (event: UndoManagerEvent) => void;

export class UndoManager {
  private readonly _doc: Doc;
  private readonly _maxUndoSteps: number;
  protected _undoStack: UndoStackItem[] = [];
  protected _redoStack: UndoStackItem[] = [];
  private _txType: "undo" | "redo" | "update" = "update";
  private _lastUpdate: number | undefined; // TODO: threeshold to combine transactions of 500ms
  private _pushHandlers = new Set<Handler>();
  private _popHandlers = new Set<Handler>();

  constructor(doc: Doc, options?: UndoManagerConfig) {
    this._doc = doc;
    this._maxUndoSteps = options?.maxUndoSteps ?? 0;
    if (!this.isEnabled) return;

    this._doc.onChange((event) => {
      if (event.flags?.skipUndo) return;
      const item: UndoStackItem = {
        operations: event.inverseOperations,
        meta: new Map(),
      };
      if (this._txType === "update") {
        if (this._maxUndoSteps > this._undoStack.length) {
          this._undoStack.push(item);
          this._pushHandlers.forEach((h) =>
            h({ meta: item.meta, type: "undo" }),
          );
        }
        this._redoStack = [];
        this._lastUpdate = Date.now();
      } else if (this._txType === "undo") {
        this._redoStack.push(item);
        this._txType = "update";
        this._pushHandlers.forEach((h) => h({ meta: item.meta, type: "redo" }));
      } else {
        this._undoStack.push(item);
        this._txType = "update";
        this._pushHandlers.forEach((h) => h({ meta: item.meta, type: "undo" }));
      }
    });
  }

  get isEnabled() {
    return this._maxUndoSteps > 0;
  }

  undo() {
    this._doc.forceCommit();
    const item = this._undoStack.pop();
    if (!item) return;
    this._txType = "undo";
    this._doc.applyOperations(item.operations);
    this._popHandlers.forEach((h) => h({ meta: item.meta, type: "undo" }));
  }

  redo() {
    this._doc.forceCommit();
    const item = this._redoStack.pop();
    if (!item) return;
    this._txType = "redo";
    this._doc.applyOperations(item.operations);
    this._popHandlers.forEach((h) => h({ meta: item.meta, type: "redo" }));
  }

  canUndo() {
    return this._undoStack.length > 0;
  }

  canRedo() {
    return this._redoStack.length > 0;
  }

  clear() {
    this._undoStack = [];
    this._redoStack = [];
    this._txType = "update";
    this._lastUpdate = undefined;
  }

  /**
   * Fires synchronously when an item is pushed to either stack.
   * Text editor bindings will often store selection state here.
   */
  onPush(handler: Handler): () => void {
    this._pushHandlers.add(handler);
    return () => {
      this._pushHandlers.delete(handler);
    };
  }

  /**
   * Fires synchronously after `applyOperations` returns on undo/redo.
   * Text editor bindings will often restore selection state here.
   */
  onPop(handler: Handler): () => void {
    this._popHandlers.add(handler);
    return () => {
      this._popHandlers.delete(handler);
    };
  }
}
