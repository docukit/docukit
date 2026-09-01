import { type Doc } from "./main.js";
import {
  mergeOperations,
  type Operations,
  type OrderedOperation,
} from "./operations.js";
import type { UndoManagerConfig } from "./types.js";

/** `meta` is opaque — consumers attach arbitrary data (e.g. selection). */
type UndoStackItem = { operations: Operations; meta: Map<string, unknown> };

export type UndoHistoryItem = {
  operations: Operations;
  meta: Record<string, unknown>;
};

export type UndoHistory = {
  docId: string;
  docType: string;
  undoStack: UndoHistoryItem[];
  redoStack: UndoHistoryItem[];
  lastUpdate?: number;
};

type UndoManagerEvent = { meta: UndoStackItem["meta"]; type: "undo" | "redo" };

type Handler = (event: UndoManagerEvent) => void;

export class UndoManager {
  private readonly _doc: Doc;
  private readonly _maxUndoSteps: number;
  private readonly _mergeInterval: number;
  protected _undoStack: UndoStackItem[] = [];
  protected _redoStack: UndoStackItem[] = [];
  private _txType: "undo" | "redo" | "update" = "update";
  private _lastUpdate: number | undefined;
  private _pushHandlers = new Set<Handler>();
  private _popHandlers = new Set<Handler>();

  constructor(doc: Doc, options?: UndoManagerConfig) {
    this._doc = doc;
    this._maxUndoSteps = options?.maxUndoSteps ?? 0;
    this._mergeInterval = options?.mergeInterval ?? 500;
    if (!this.isEnabled) return;

    this._doc.onChange((event) => {
      if (event.flags?.skipUndo) return;
      const item: UndoStackItem = {
        operations: event.inverseOperations,
        meta: new Map(),
      };
      if (this._txType === "update") {
        const now = Date.now();
        const lastItem = this._undoStack.at(-1);
        if (
          lastItem &&
          this._lastUpdate !== undefined &&
          now - this._lastUpdate < this._mergeInterval
        ) {
          lastItem.operations = mergeOperations(
            item.operations,
            lastItem.operations,
          );
          this._pushHandlers.forEach((h) =>
            h({ meta: lastItem.meta, type: "undo" }),
          );
        } else {
          if (this._undoStack.length >= this._maxUndoSteps) {
            this._undoStack.shift();
          }
          this._undoStack.push(item);
          this._pushHandlers.forEach((h) =>
            h({ meta: item.meta, type: "undo" }),
          );
        }
        this._redoStack = [];
        this._lastUpdate = now;
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
    this._lastUpdate = undefined;
    this._doc.applyOperations(item.operations);
    this._popHandlers.forEach((h) => h({ meta: item.meta, type: "undo" }));
  }

  redo() {
    this._doc.forceCommit();
    const item = this._redoStack.pop();
    if (!item) return;
    this._txType = "redo";
    this._lastUpdate = undefined;
    this._doc.applyOperations(item.operations);
    this._popHandlers.forEach((h) => h({ meta: item.meta, type: "redo" }));
  }

  canUndo() {
    return this._undoStack.length > 0;
  }

  canRedo() {
    return this._redoStack.length > 0;
  }

  /**
   * Exports undo and redo state without exporting editor-specific listeners.
   * Metadata uses plain objects so consumers can persist histories whose
   * metadata values are supported by their chosen storage format.
   */
  exportHistory(): UndoHistory {
    this._doc.forceCommit();
    return {
      docId: this._doc.root.id,
      docType: this._doc.root.type,
      undoStack: this._undoStack.map(exportStackItem),
      redoStack: this._redoStack.map(exportStackItem),
      ...(this._lastUpdate !== undefined && { lastUpdate: this._lastUpdate }),
    };
  }

  /**
   * Replaces this manager's history with a previously exported history.
   * The document ID and type must match because operations contain node IDs.
   */
  importHistory(history: unknown): void {
    if (!isUndoHistory(history)) {
      throw new TypeError("Invalid undo history");
    }
    if (
      history.docId !== this._doc.root.id ||
      history.docType !== this._doc.root.type
    ) {
      throw new Error("Undo history belongs to a different document");
    }

    const maxSteps = this._maxUndoSteps;
    this._undoStack = importStack(history.undoStack, maxSteps);
    this._redoStack = importStack(history.redoStack, maxSteps);
    this._lastUpdate = history.lastUpdate;
    this._txType = "update";
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

function cloneOperations(operations: Operations): Operations {
  const orderedOperations = operations[0].map(cloneOrderedOperation);
  const statePatch = Object.fromEntries(
    Object.entries(operations[1]).map(([id, state]) => [id, { ...state }]),
  );
  return [orderedOperations, statePatch];
}

function cloneOrderedOperation(operation: OrderedOperation): OrderedOperation {
  if (operation[0] === 0) {
    return [
      0,
      operation[1].map(([id, type]) => [id, type]),
      operation[2],
      operation[3],
      operation[4],
    ];
  }
  if (operation[0] === 1) {
    return [1, operation[1], operation[2]];
  }
  return [
    2,
    operation[1],
    operation[2],
    operation[3],
    operation[4],
    operation[5],
  ];
}

function exportStackItem(item: UndoStackItem): UndoHistoryItem {
  return {
    operations: cloneOperations(item.operations),
    meta: Object.fromEntries(item.meta),
  };
}

function importStack(items: UndoHistoryItem[], maxSteps: number) {
  const retainedItems = maxSteps === 0 ? [] : items.slice(-maxSteps);
  return retainedItems.map((item) => ({
    operations: cloneOperations(item.operations),
    meta: new Map(Object.entries(item.meta)),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(isString);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNodeReference(value: unknown): value is string | 0 {
  return value === 0 || typeof value === "string";
}

function isOrderedOperation(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value[0] === 0) {
    return (
      value.length === 5 &&
      Array.isArray(value[1]) &&
      value[1].every(
        (node) =>
          Array.isArray(node) && node.length === 2 && node.every(isString),
      ) &&
      isNodeReference(value[2]) &&
      isNodeReference(value[3]) &&
      isNodeReference(value[4])
    );
  }
  if (value[0] === 1) {
    return (
      value.length === 3 &&
      typeof value[1] === "string" &&
      isNodeReference(value[2])
    );
  }
  if (value[0] === 2) {
    return (
      value.length === 6 &&
      typeof value[1] === "string" &&
      isNodeReference(value[2]) &&
      isNodeReference(value[3]) &&
      isNodeReference(value[4]) &&
      isNodeReference(value[5])
    );
  }
  return false;
}

function isOperations(value: unknown): value is Operations {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const orderedOperations: unknown = value[0];
  const statePatch: unknown = value[1];
  return (
    Array.isArray(orderedOperations) &&
    orderedOperations.every(isOrderedOperation) &&
    isRecord(statePatch) &&
    Object.values(statePatch).every(isStringRecord)
  );
}

function isHistoryItem(value: unknown): value is UndoHistoryItem {
  return (
    isRecord(value) && isOperations(value.operations) && isRecord(value.meta)
  );
}

function isUndoHistory(value: unknown): value is UndoHistory {
  return (
    isRecord(value) &&
    typeof value.docId === "string" &&
    typeof value.docType === "string" &&
    Array.isArray(value.undoStack) &&
    value.undoStack.every(isHistoryItem) &&
    Array.isArray(value.redoStack) &&
    value.redoStack.every(isHistoryItem) &&
    (value.lastUpdate === undefined ||
      (typeof value.lastUpdate === "number" &&
        Number.isFinite(value.lastUpdate)))
  );
}
