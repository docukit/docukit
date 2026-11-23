import { type Doc } from "./main.js";
import {
  compactOperations,
  mergeDrafts,
  type DraftOperations,
  type Operations,
  type OrderedOperation,
} from "./operations.js";
import type { InternalStateDefinition, UndoManagerConfig } from "./types.js";
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
  readonly #doc: Doc;
  readonly #maxUndoSteps: number;
  readonly #mergeInterval: number;
  protected _undoStack: UndoStackItem[] = [];
  #redoStack: UndoStackItem[] = [];
  #txType: "undo" | "redo" | "update" = "update";
  #lastUpdate: number | undefined;
  #pushHandlers = new Set<Handler>();
  #popHandlers = new Set<Handler>();

  constructor(doc: Doc, options?: UndoManagerConfig) {
    this.#doc = doc;
    this.#maxUndoSteps = options?.maxUndoSteps ?? 0;
    this.#mergeInterval = options?.mergeInterval ?? 500;
    if (!this.isEnabled) return;

    this.#doc.onChange((event) => {
      if (event.flags?.skipUndo) return;
      // The inverse as the core built it: decoding the event's batch would
      // only undo its encoding.
      const item: UndoStackItem = {
        operations: this.#doc["_inverseOperations"],
        meta: new Map(),
      };
      if (this.#txType === "update") {
        const now = Date.now();
        const lastItem = this._undoStack.at(-1);
        if (
          lastItem &&
          this.#lastUpdate !== undefined &&
          now - this.#lastUpdate < this.#mergeInterval
        ) {
          lastItem.operations = mergeDrafts(
            item.operations,
            lastItem.operations,
          );
          this.#pushHandlers.forEach((h) =>
            h({ meta: lastItem.meta, type: "undo" }),
          );
        } else {
          if (this._undoStack.length >= this.#maxUndoSteps) {
            this._undoStack.shift();
          }
          this._undoStack.push(item);
          this.#pushHandlers.forEach((h) =>
            h({ meta: item.meta, type: "undo" }),
          );
        }
        this.#redoStack = [];
        this.#lastUpdate = now;
      } else if (this.#txType === "undo") {
        this.#redoStack.push(item);
        this.#txType = "update";
        this.#pushHandlers.forEach((h) => h({ meta: item.meta, type: "redo" }));
      } else {
        this._undoStack.push(item);
        this.#txType = "update";
        this.#pushHandlers.forEach((h) => h({ meta: item.meta, type: "undo" }));
      }
    });
  }

  get isEnabled() {
    return this.#maxUndoSteps > 0;
  }

  undo() {
    this.#doc.forceCommit();
    const item = this._undoStack.pop();
    if (!item) return;
    this.#txType = "undo";
    this.#lastUpdate = undefined;
    try {
      this.#doc.applyOperations(this.#prepare(item.operations));
    } finally {
      // Nothing may have changed (every operation was skipped), in which case
      // no change event resets the mode. It must not leak into the next edit.
      this.#txType = "update";
    }
    this.#popHandlers.forEach((h) => h({ meta: item.meta, type: "undo" }));
  }

  redo() {
    this.#doc.forceCommit();
    const item = this.#redoStack.pop();
    if (!item) return;
    this.#txType = "redo";
    this.#lastUpdate = undefined;
    try {
      this.#doc.applyOperations(this.#prepare(item.operations));
    } finally {
      this.#txType = "update";
    }
    this.#popHandlers.forEach((h) => h({ meta: item.meta, type: "redo" }));
  }

  canUndo() {
    return this._undoStack.length > 0;
  }

  canRedo() {
    return this.#redoStack.length > 0;
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
    this.#doc.forceCommit();
    return {
      docId: this.#doc.root.id,
      docType: this.#doc.root.type,
      undoStack: this._undoStack.map(exportStackItem),
      redoStack: this.#redoStack.map(exportStackItem),
      ...(this.#lastUpdate !== undefined && { lastUpdate: this.#lastUpdate }),
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
      history.docId !== this.#doc.root.id ||
      history.docType !== this.#doc.root.type
    ) {
      throw new Error("Undo history belongs to a different document");
    }

    const maxSteps = this.#maxUndoSteps;
    this._undoStack = importStack(history.undoStack, maxSteps);
    this.#redoStack = importStack(history.redoStack, maxSteps);
    this.#lastUpdate = history.lastUpdate;
    this.#txType = "update";
  }

  /** What applying a history item applies (see `prepareUndo`). */
  #prepare([ordered, patch]: DraftOperations): Operations {
    const definition = editDefinition(this.#doc);
    const prepared = ordered.map((operation): OrderedOperation => {
      if (operation[0] !== 3 || !definition?.prepareUndo) return operation;
      return definition.prepareUndo(operation, this.#doc);
    });
    return compactOperations([prepared, patch]);
  }

  /**
   * Fires synchronously when an item is pushed to either stack.
   * Text editor bindings will often store selection state here.
   */
  onPush(handler: Handler): () => void {
    this.#pushHandlers.add(handler);
    return () => {
      this.#pushHandlers.delete(handler);
    };
  }

  /**
   * Fires synchronously after `applyOperations` returns on undo/redo.
   * Text editor bindings will often restore selection state here.
   */
  onPop(handler: Handler): () => void {
    this.#popHandlers.add(handler);
    return () => {
      this.#popHandlers.delete(handler);
    };
  }
}

/** The definition of the root state that receives edit operations, if any. */
function editDefinition(doc: Doc): InternalStateDefinition | undefined {
  const key = doc["_editStateKey"];
  if (key === undefined) return undefined;
  return doc["_resolvedNodeDefs"].get(doc.root.type)?.state[key];
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

/** `[text | [node] | 5 | -tag, ...]` (see `wire.ts`). */
function isTextRow(value: unknown[]): boolean {
  const head: unknown = value[0];
  return (
    typeof head === "string" ||
    (Array.isArray(head) && head.length === 1 && isString(head[0])) ||
    head === 5 ||
    (Number.isInteger(head) && Number(head) < 0)
  );
}

/**
 * `[0, [[id, type, count?], ...], parent?, prev?, next?]`, `[0, id, type,
 * parent?, prev?, next?]`, `[1, start?, end?]` or `[2, start, end?, parent?,
 * prev?, next?]`.
 */
function isTreeRow([tag, first, ...rest]: unknown[]): boolean {
  if (tag === 0 && isNodeReference(first)) {
    const [type, ...anchors] = rest;
    return (
      isString(type) && anchors.length <= 3 && anchors.every(isNodeReference)
    );
  }
  if (tag === 1 && first === undefined) return true;
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
function isPatchRow([, ...entries]: unknown[]): boolean {
  if (entries.length % 3 !== 0) return false;
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

/**
 * A tree row starts with 0, 1 or 2, the state patch with -9, a text row with
 * anything else.
 */
function isRow(value: unknown, last: boolean): boolean {
  if (!Array.isArray(value)) return false;
  const row: unknown[] = value;
  // The state patch is the last row.
  if (row[0] === -9) return last && isPatchRow(row);
  return typeof row[0] === "number" && row[0] >= 0 && row[0] !== 5
    ? isTreeRow(row)
    : isTextRow(row);
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
  if (typeof rows[0] === "string" || typeof rows[0] === "number")
    return isRow(rows, true);
  return rows.every((row, index) => {
    if (typeof row === "string") return /^\d*\.[\w-]+$/.test(row);
    return isRow(row, index === rows.length - 1);
  });
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
