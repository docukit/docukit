import { type Doc } from "./main.js";
import {
  compactOperations,
  mergeDrafts,
  type DraftOperations,
  type Operations,
} from "./operations.js";
import type { UndoManagerConfig } from "./types.js";
import { decodeOperations } from "./wire.js";

/**
 * `meta` is opaque — consumers attach arbitrary data (e.g. selection). The
 * operations are kept as the document builds them: merging the steps of a
 * burst of typing then needs no decoding.
 */
type UndoStackItem = {
  operations: DraftOperations;
  meta: Map<string, unknown>;
};

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
      // The inverse as the core built it: decoding the event's batch would
      // only undo its encoding.
      const item: UndoStackItem = {
        operations: this._doc["_inverseOperations"],
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
          lastItem.operations = mergeDrafts(
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
    try {
      this._doc.applyOperations(compactOperations(item.operations));
    } finally {
      // Nothing may have changed (every operation was skipped), in which case
      // no change event resets the mode. It must not leak into the next edit.
      this._txType = "update";
    }
    this._popHandlers.forEach((h) => h({ meta: item.meta, type: "undo" }));
  }

  redo() {
    this._doc.forceCommit();
    const item = this._redoStack.pop();
    if (!item) return;
    this._txType = "redo";
    this._lastUpdate = undefined;
    try {
      this._doc.applyOperations(compactOperations(item.operations));
    } finally {
      this._txType = "update";
    }
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
    // Not only for the history: DocSync relies on this commit to push a pending
    // edit into its local operations batch, so the replacement document picks
    // it up. Do not skip it when undo is disabled.
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

function exportStackItem(item: UndoStackItem): UndoHistoryItem {
  return {
    operations: compactOperations(item.operations),
    // Intentionally shallow: history handoff normally disposes the source doc,
    // while persistence owns serialization of its opaque metadata values. A
    // deep clone would reject valid non-serializable editor metadata.
    meta: Object.fromEntries(item.meta),
  };
}

function importStack(items: UndoHistoryItem[], maxSteps: number) {
  const retainedItems = maxSteps === 0 ? [] : items.slice(-maxSteps);
  return retainedItems.map((item) => ({
    operations: decodeOperations(item.operations),
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

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** A node of a tree row: a string, a number (its distance), or `0`, none. */
function isNodeReference(value: unknown): boolean {
  return Number.isInteger(value) || typeof value === "string";
}

/**
 * `[0, [[id, type, count?], ...], parent?, prev?, next?]`, `[1, start, end?]`
 * or `[2, start, end?, parent?, prev?, next?]`.
 */
function isTreeRow([tag, first, ...rest]: unknown[]): boolean {
  if (!rest.every(isNodeReference)) return false;
  if (tag === 0)
    return (
      rest.length <= 3 &&
      Array.isArray(first) &&
      first.every(
        (node) =>
          Array.isArray(node) &&
          (node.length === 2 ||
            (node.length === 3 && Number.isInteger(node[2]))) &&
          isNodeReference(node[0]) &&
          isString(node[1]),
      )
    );
  return (
    isNodeReference(first) &&
    rest.length <= (tag === 1 ? 1 : tag === 2 ? 4 : -1)
  );
}

/**
 * `[-9, node, key, value, ...]`: a triple per key, `[node, count]` for a run
 * of nodes.
 */
function isPatchRow([tag, ...entries]: unknown[]): boolean {
  if (tag !== -9 || entries.length % 3 !== 0) return false;
  for (let at = 0; at < entries.length; at += 3) {
    const node = entries[at];
    const run =
      Array.isArray(node) &&
      node.length === 2 &&
      isNodeReference(node[0]) &&
      Number.isInteger(node[1]);
    if (!(run || isNodeReference(node)) || !isString(entries[at + 1]))
      return false;
  }
  return true;
}

/** A tree row starts with 0, 1 or 2, the state patch with -9. */
function isRow(value: unknown, last: boolean): boolean {
  if (!Array.isArray(value)) return false;
  const row: unknown[] = value;
  // The state patch is the last row.
  return isTreeRow(row) || (last && isPatchRow(row));
}

function isOperations(value: unknown): value is Operations {
  if (!Array.isArray(value) || value.length < 2) return false;
  const list: unknown[] = value;
  const [head, ...rows] = list;
  if (
    typeof head !== "string" &&
    !(Array.isArray(head) && head.length > 0 && head.every(isString))
  )
    return false;
  // One row written without its brackets.
  if (typeof rows[0] === "number") return isRow(rows, true);
  return rows.every((row, index) => isRow(row, index === rows.length - 1));
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
