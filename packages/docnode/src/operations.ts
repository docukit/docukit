import { type Doc, type DocNode } from "./main.js";
import {
  type ChangeEvent,
  type Json,
  type StateDefinition,
  type UnsafeDefinition,
} from "./types.js";
import { detachRange, equalJson, freezeInDev, isObjectEmpty } from "./utils.js";
import { decodeOperations, encodeOperations } from "./wire.js";

/**
 * The JSON of a node's state value, as its definition's `toJSON` writes it,
 * or of the default when the key was never set. Operations keep it as it is:
 * state values are not changed in place (they are frozen in development).
 */
export function stateKeyToJson(node: DocNode, key: string): Json {
  const resolvedNodeDef = node.doc["_resolvedNodeDefs"].get(node.type)!;
  if (!(key in node["_state"])) return resolvedNodeDef.defaultJson[key]!;
  const stateValue = (node as DocNode<UnsafeDefinition>)["_state"][key];
  return stateValueToJson(
    node.type,
    key,
    resolvedNodeDef.state[key],
    stateValue,
  );
}

/**
 * The plain JSON of a state `value` of `key` on a node of `type`, through
 * its definition's `toJSON`, which must not return `undefined` or a function.
 */
export function stateValueToJson(
  type: string,
  key: string,
  definition: StateDefinition | undefined,
  value: unknown,
): Json {
  const json: unknown = definition?.toJSON ? definition.toJSON(value) : value;
  if (json === undefined || typeof json === "function")
    throw new Error(
      `The JSON serialization for state ${key} on a node of type ${type} is undefined.`,
    );
  return toPlainJson(json);
}

/**
 * `json` as plain JSON: an object that is not a plain object or list (a
 * Date, a class) is what `JSON.stringify` writes of it, so that it stays the
 * same through `structuredClone` (IndexedDB) and travels as it is stored.
 */
export function toPlainJson(json: unknown): Json {
  if (typeof json === "object" && json) {
    const proto: unknown = Object.getPrototypeOf(json);
    if (proto !== Object.prototype && proto !== Array.prototype)
      return JSON.parse(JSON.stringify(json)) as Json;
  }
  return json as Json;
}

export function stringifyStateKey(node: DocNode, key: string): string {
  return JSON.stringify(stateKeyToJson(node, key));
}

/** The state value of `json`, as the key's definition reads it. */
export function parseStateKey(node: DocNode, key: string, json: Json): unknown {
  const stateDef = node.doc["_resolvedNodeDefs"].get(node.type)?.state[key];
  return stateDef?.fromJSON(json);
}

export const onSetState = {
  operations: (node: DocNode, key: string) => {
    const { doc } = node;
    const statePatchs = doc["_operations"][1];
    const value = stateKeyToJson(node, key);

    const inversePatch = doc["_inverseOperations"][1].get(node.id);
    const prevValue = inversePatch?.[key];
    const nodePatch = statePatchs.get(node.id);
    if (prevValue !== undefined && nodePatch && equalJson(prevValue, value)) {
      delete nodePatch[key];
      if (isObjectEmpty(nodePatch)) {
        statePatchs.delete(node.id);
        // A change of its text keeps it updated.
        if (!doc["_textChanges"]?.has(node))
          doc["_diff"].updated.delete(node.id);
      }
      delete inversePatch![key];
    } else {
      patchOf(statePatchs, node.id)[key] = value;
      if (!doc["_diff"].inserted.has(node.id))
        doc["_diff"].updated.add(node.id);
    }
  },
  inverseOps: (node: DocNode, key: string) => {
    const { doc } = node;
    const insertedInSameTransaction = doc["_diff"].inserted.has(node.id);
    if (insertedInSameTransaction) return;
    const inverseStatePatchs = doc["_inverseOperations"][1];
    const inverse = patchOf(inverseStatePatchs, node.id);
    if (inverse[key] !== undefined) return;
    inverse[key] = stateKeyToJson(node, key);
  },
};

export const onInsertRange = (
  doc: Doc,
  target: DocNode,
  position: "append" | "before",
  nodes: DocNode[],
) => {
  let newNext: DocNode | undefined;
  let newPrev: DocNode | undefined;
  let newParent: DocNode;

  switch (position) {
    case "append":
      newPrev = target.last;
      newParent = target;
      break;
    case "before":
      newNext = target;
      newPrev = target.prev;
      newParent = target.parent!;
      break;
  }
  doc["_operations"][0].push([
    0,
    nodes.map((node) => [node.id, node.type]),
    newParent === doc.root ? 0 : newParent.id,
    newPrev?.id ?? 0,
    newNext?.id ?? 0,
  ]);
  if (!doc["_diff"].inserted.has(newParent.id)) {
    doc["_inverseOperations"][0].push([
      1,
      nodes[0]!.id,
      nodes.length > 1 ? nodes.at(-1)!.id : 0,
    ]);
  }
  for (const node of nodes) {
    copyInsertedToDiff(node);
    onInsertChildren(doc, node);
  }
};

/**
 * The descendants of an inserted node, in the order a walk of them finds
 * them: each list of children is inserted when its first child is found.
 */
function onInsertChildren(doc: Doc, parent: DocNode) {
  const first = parent.first;
  if (!first) return;
  const written: [string, string][] = [];
  for (let child: DocNode | undefined = first; child; child = child.next)
    written.push([child.id, child.type]);
  doc["_operations"][0].push([0, written, parent.id, 0, 0]);
  // After the insert of the list: the inserts of its texts' letters follow it.
  copyInsertedToDiff(first);
  if (!doc["_diff"].inserted.has(parent.id)) {
    const last = parent.last!;
    doc["_inverseOperations"][0].push([
      1,
      first.id,
      last !== first ? last.id : 0,
    ]);
  }
  onInsertChildren(doc, first);
  for (let child = first.next; child; child = child.next) {
    copyInsertedToDiff(child);
    onInsertChildren(doc, child);
  }
}

function copyInsertedToDiff(node: DocNode) {
  const doc = node.doc;
  const diff = doc["_diff"];
  const deletedInSameTransaction = diff.deleted.delete(node.id);
  if (deletedInSameTransaction) {
    diff.moved.add(node.id);
    doc["_diff"].updated.add(node.id);
  } else {
    diff.inserted.add(node.id);
  }
  // [#4GOSK]
  const jsonState = node["_stateJson"](false);
  if (!isObjectEmpty(jsonState)) doc["_operations"][1].set(node.id, jsonState);
  const textKeys = doc["_resolvedNodeDefs"].get(node.type)!.textKeys;
  if (textKeys)
    doc["_textEngine"]!.attach(node, textKeys, doc["_operations"][0]);
}

export const onDeleteRange = (
  doc: Doc,
  startNode: DocNode,
  endNode: DocNode,
) => {
  const operations = doc["_operations"][0];
  const inverseOperations = doc["_inverseOperations"][0];
  const tempInverseOperations: OrderedOperation[] = [];
  const parent = startNode.parent!;

  operations.push([1, startNode.id, startNode !== endNode ? endNode.id : 0]);
  const jsonNodes: [string, string][] = [];
  startNode.to(endNode).forEach((node) => {
    jsonNodes.push([node.id, node.type]);
    copyDeletedToDiff(node);
  });
  // If the parent was inserted in the same transaction, it means that
  // is deleted in inverseOps, so it is not possible to insert descendants.
  const shouldAddToInverseOps = !doc["_diff"].inserted.has(parent.id);
  if (shouldAddToInverseOps) {
    tempInverseOperations.push([
      0,
      jsonNodes,
      parent === doc.root ? 0 : parent.id,
      startNode.prev?.id ?? 0,
      endNode.next?.id ?? 0,
    ]);
  }

  detachRange(startNode, endNode);
  // The inserts that put the texts' letters back, after the nodes.
  const textInserts: OrderedOperation[] = [];
  const definitions = doc["_resolvedNodeDefs"];
  startNode.to(endNode).forEach((node) => {
    node.descendants({ includeSelf: true }).forEach((node) => {
      doc["_operations"][1].delete(node.id);
      doc["_diff"].updated.delete(node.id);
      const textKeys = definitions.get(node.type)!.textKeys;
      if (textKeys)
        doc["_textEngine"]!.detach(
          node,
          textKeys,
          shouldAddToInverseOps ? textInserts : undefined,
        );
      if (node.first) {
        const jsonNodes: [string, string][] = [];
        node.children().forEach((childNode) => {
          copyDeletedToDiff(childNode);
          jsonNodes.push([childNode.id, childNode.type]);
        });
        if (shouldAddToInverseOps) {
          tempInverseOperations.push([0, jsonNodes, node.id, 0, 0]);
        }
      }
    });
  });
  /**
   * All operations are reversed in main.ts. But we reverse the delete operations
   * again here because they're the only ones that don't need to be reversed
   * (reversed + reversed = not reversed). This is because descendants are removed
   * after the ancestors.
   * TODO: To avoid a reverse and make this more performant, we can use an iterator
   * other than.descendants().forEach above.
   */
  tempInverseOperations.push(...textInserts);
  inverseOperations.push(...tempInverseOperations.reverse());
};

export const onMoveRange = (
  doc: Doc,
  startNode: DocNode,
  endNode: DocNode,
  newParent: DocNode,
  newPrev: DocNode | undefined,
  newNext: DocNode | undefined,
) => {
  const endId = endNode.id === startNode.id ? 0 : endNode.id;
  doc["_operations"][0].push([
    2,
    startNode.id,
    endId,
    newParent === doc.root ? 0 : newParent.id,
    newPrev?.id ?? 0,
    newNext?.id ?? 0,
  ]);
  // TODO: non-null assertion because it doesn't make sense to move root
  // but should be tested!
  const currentParent = startNode.parent!;
  const currentPrev = startNode.prev;
  const currentNext = endNode.next;
  doc["_inverseOperations"][0].push([
    2,
    startNode.id,
    endId,
    currentParent === doc.root ? 0 : currentParent.id,
    currentPrev?.id ?? 0,
    currentNext?.id ?? 0,
  ]);
  startNode.to(endNode).forEach((node) => {
    if (!doc["_diff"].inserted.has(node.id)) doc["_diff"].moved.add(node.id);
  });
};

export const onApplyOperations = (doc: Doc, operations: DraftOperations) => {
  // Up to the length it has now, like `forEach`: an abort applies the inverse
  // batch, and applying it adds to that same batch.
  const ordered = operations[0];
  const length = ordered.length;
  for (let index = 0; index < length; index++) {
    const operation = ordered[index]!;
    switch (operation[0]) {
      case 0:
        // Deleting or moving a missing node skips that operation and keeps
        // applying the batch. Inserting a node that already exists is treated
        // the same way: the intent is already satisfied. Undo steps depend on
        // this when an excluded change restored the node first.
        const list = operation[1];
        const nodes: DocNode[] = [];
        for (const entry of list) {
          if (!doc.getNodeById(entry[0]))
            nodes.push(doc["_insertedNode"](entry[0], entry[1]));
        }
        if (nodes.length === 0) break;
        const prev = operation[3] ? doc.getNodeById(operation[3]) : undefined;
        if (prev) {
          doc["_insertRange"](prev, "after", nodes);
          break;
        }
        const next = operation[4] ? doc.getNodeById(operation[4]) : undefined;
        if (next) {
          doc["_insertRange"](next, "before", nodes);
          break;
        }
        const parent = operation[2] ? doc.getNodeById(operation[2]) : doc.root;
        if (parent) doc["_insertRange"](parent, "append", nodes);
        break;
      case 1:
        const start = doc.getNodeById(operation[1]);
        // An id that is not of a node may be of a letter (see `text.ts`).
        if (!start) {
          doc["_textEngine"]?.delete(doc, operation[1], operation[2]);
          break;
        }
        try {
          start.to(doc.getNodeById(operation[2] || operation[1])!).delete();
        } catch {}
        break;
      case 2:
        const startNode = doc.getNodeById(operation[1]);
        // An id that is not of a node may be of a letter (see `text.ts`).
        if (!startNode) {
          doc["_textEngine"]?.move(doc, operation);
          break;
        }
        const endNode = doc.getNodeById(operation[2] || operation[1]);
        if (!endNode) break;
        // A move is a delete plus an insert. Like an insert, it is dropped
        // when its new parent was deleted by a concurrent change, so the range
        // ends up deleted. Otherwise an anchor deleted concurrently falls back
        // to the next one: previous sibling, next sibling, then the parent.
        const parentNode = operation[3]
          ? doc.getNodeById(operation[3])
          : doc.root;
        const prevNode = operation[4]
          ? doc.getNodeById(operation[4])
          : undefined;
        const nextNode = operation[5]
          ? doc.getNodeById(operation[5])
          : undefined;
        try {
          if (!parentNode) startNode.to(endNode).delete();
          else if (prevNode) startNode.to(endNode).move(prevNode, "after");
          else if (nextNode) startNode.to(endNode).move(nextNode, "before");
          else startNode.to(endNode).move(parentNode, "append");
        } catch {}
        break;
      case 4:
        doc["_textEngine"]?.insert(doc, operation);
        break;
    }
  }
  // Apply state patch
  const toApplyStatePatch = operations[1];
  const currentStatePatch = doc["_operations"][1];
  const currentInverseStatePatch = doc["_inverseOperations"][1];
  for (const [id, state] of toApplyStatePatch) {
    const node = doc.getNodeById(id);
    if (!node) continue;
    const insertedInSameTransaction = doc["_diff"].inserted.has(id);
    const textKeys = doc["_resolvedNodeDefs"].get(node.type)!.textKeys;
    for (const key in state) {
      // A text changes only through its letters (see `text.ts`).
      if (textKeys?.includes(key)) continue;
      const value = state[key]!;
      // The state of a node inserted in this transaction is part of its
      // creation and needs no inverse: the inverse operation is a delete.
      if (!insertedInSameTransaction) {
        const current = stateKeyToJson(node, key);
        // A value already in place is treated as applied, like an insert of
        // an existing node. It changes nothing and needs no inverse.
        if (equalJson(current, value)) continue;
        doc["_diff"].updated.add(id);
        // The first inverse of a key in the transaction wins, even `null`.
        const inverse = patchOf(currentInverseStatePatch, id);
        if (inverse[key] === undefined) inverse[key] = current;
      }
      patchOf(currentStatePatch, id)[key] = value;
      // The value is the batch's: frozen, like a value set here.
      node["_values"]()[key] = freezeInDev(parseStateKey(node, key, value));
    }
  }
};

/** Whether the transaction of `doc` changed something. */
const hasChanges = (doc: Doc) => {
  const diff = doc["_diff"];
  return (
    diff.inserted.size > 0 ||
    diff.deleted.size > 0 ||
    diff.moved.size > 0 ||
    diff.updated.size > 0 ||
    doc["_operations"][1].size > 0
  );
};

/** Calls each normalize listener of `doc`, if it has any. */
const normalize = (doc: Doc) => {
  const listeners = doc["_normalizeListeners"];
  if (listeners.size === 0) return;
  for (const listener of listeners) listener({ diff: doc["_diff"] });
};

/**
 * The event of a change. Its own function, so the closures of its getters
 * are made only when someone listens, not in every transaction.
 */
const changeEvent = (doc: Doc): ChangeEvent => {
  const operations = doc["_operations"];
  const inverseOperations = doc["_inverseOperations"];
  let encoded: Operations | undefined;
  let inverseEncoded: Operations | undefined;
  // The batches are written when a listener reads them, once for all, as
  // Yjs writes its update only when someone listens to it (`Transaction.js`):
  // the undo manager keeps the inverse as it is built, and loading a
  // document inserts all its nodes.
  return {
    get operations() {
      return (encoded ??= encodeOperations(operations));
    },
    get inverseOperations() {
      return (inverseEncoded ??= encodeOperations(inverseOperations));
    },
    diff: doc["_diff"],
    flags: doc["_transactionFlags"],
  };
};

/** We trigger listeners at the end of each update if there were operations (i.e. something changed) */
export const maybeTriggerListeners = (doc: Doc, ignoreEmptyDiff = false) => {
  if (!ignoreEmptyDiff && !hasChanges(doc)) return;
  doc["_lifeCycleStage"] = "normalize";
  normalize(doc);
  if (doc["_strictMode"]) {
    doc["_lifeCycleStage"] = "normalize2";
    normalize(doc);
  }
  if (!hasChanges(doc)) return;
  doc["_lifeCycleStage"] = "change";
  const listeners = doc["_changeListeners"];
  if (listeners.size === 0) return;
  const event = changeEvent(doc);
  for (const listener of listeners) listener(event);
};

const copyDeletedToDiff = (node: DocNode) => {
  const doc = node.doc;
  const diff = doc["_diff"];
  // remove from operations.statePatch if its state changed in the same transaction
  // remove from diff if it was inserted in the same transaction
  const insertedInSameTransaction = diff.inserted.delete(node.id);
  if (insertedInSameTransaction) {
    diff.moved.delete(node.id);
  } else {
    // backup the previous state in inverseOperations.statePatch
    const inversePatch = doc["_inverseOperations"][1];
    const currentState = node["_stateJson"](false);
    const previousState = { ...currentState, ...inversePatch.get(node.id) };
    inversePatch.set(node.id, previousState);
    // add to diff.deleted
    diff.deleted.set(node.id, node);
  }
};

type InsertOperation = [
  operation: 0,
  nodes: [id: string, type: string][],
  parent: string | 0,
  prev: string | 0,
  next: string | 0,
];

type DeleteOperation = [operation: 1, start: string, end: string | 0];

/**
 * A move of nodes, or of letters (see `text.ts`): an id is of a node or of a
 * letter, never both. Letters go right after `prev`, or if it is gone right
 * before `next`, with `parent` `0`; with `key`, into the empty text of that
 * key of `node` (`0` for the root), or at its start if it has letters.
 */
export type MoveOperation =
  | [
      operation: 2,
      start: string,
      end: string | 0,
      parent: string | 0,
      prev: string | 0,
      next: string | 0,
    ]
  | [
      operation: 2,
      first: string,
      last: string | 0,
      node: string | 0,
      prev: 0,
      next: 0,
      key: string,
    ];

/**
 * An insert of letters (see `text.ts`): `text`, whose letters take the
 * clocks from `first` on, right after `prev`, or if it is gone right before
 * `next` (`0` for none). With `key`, into the empty text of that key of
 * `node` (`0` for the root), or at its start if it has letters.
 */
export type TextOperation =
  | [
      operation: 4,
      first: string,
      prev: string | 0,
      next: string | 0,
      text: string,
    ]
  | [
      operation: 4,
      first: string,
      prev: 0,
      next: 0,
      text: string,
      node: string | 0,
      key: string,
    ];

export type OrderedOperation =
  | InsertOperation
  | DeleteOperation
  | MoveOperation
  | TextOperation;

// TODO: not implemented yet
// type ChangeTypeOperation = [
//   operation: 3,
//   type: string,
//   start: string,
//   end: string | 0,
//   includeDescendants: 1 | 0,
// ]

/**
 * The new value of each changed key of each node, as JSON. A `Map`, since its
 * keys are mostly new node ids: an object would get a new shape for each.
 */
export type StatePatch = Map<string, Record<string, Json>>;

/** The patch of node `id` in `patch`, which it adds if missing. */
export function patchOf(patch: StatePatch, id: string) {
  let state = patch.get(id);
  if (!state) patch.set(id, (state = {}));
  return state;
}

/**
 * The operations of a transaction as the document records and applies them,
 * with whole node ids. `Operations` is how they travel (see `wire.ts`).
 */
export type DraftOperations = readonly [OrderedOperation[], StatePatch];

/**
 * A node in a batch: a number is a node of the head's session, by its
 * clock's distance from the head's (see `wire.ts`); a string is a whole node
 * id. `0` is none: the root as a parent, or no sibling.
 */
export type NodeRef = string | number;

/**
 * A batch of operations as it travels and is stored: plain JSON, read on its
 * own. See `wire.ts`.
 */
export type Operations =
  | readonly [head: string, ...rows: OperationsRow[]]
  /** A batch of one row that is not a state patch, without its brackets. */
  | readonly [head: string, ...row: OrderedRow];

export type OperationsRow = OrderedRow | PatchRow | LetterRow;

/**
 * An insert of letters (see `wire.ts`): `"prev,next|text"`, `"prev|text"`
 * or `"@node,key|text"`, after `"N>"` when its letters start elsewhere.
 */
export type LetterRow = string;

/** A row that inserts, deletes or moves nodes, without its trailing zeros. */
export type OrderedRow =
  | readonly [
      op: 0,
      /** A count is a run of nodes made one after the other. */
      nodes: readonly (
        | readonly [node: NodeRef, type: string]
        | readonly [node: NodeRef, type: string, count: number]
      )[],
      parent?: NodeRef,
      prev?: NodeRef,
      next?: NodeRef,
    ]
  /** One node, without the list. */
  | readonly [
      op: 0,
      node: NodeRef,
      type: string,
      parent?: NodeRef,
      prev?: NodeRef,
      next?: NodeRef,
    ]
  | readonly [op: 1, start: NodeRef, end?: NodeRef]
  | readonly [
      op: 2,
      start: NodeRef,
      end?: NodeRef,
      parent?: NodeRef,
      prev?: NodeRef,
      next?: NodeRef,
    ]
  /** A move of letters into the empty text of `key` of `node`. */
  | readonly [
      op: 2,
      first: NodeRef,
      last: NodeRef,
      node: NodeRef,
      prev: 0,
      next: 0,
      key: string,
    ];

/**
 * The state patch, always the last row: `[3, node, key, value, ...]`, a
 * triple per key a node changed, or `[node, count], key, values` for a key
 * set on a run of nodes.
 */
export type PatchRow = readonly [op: 3, ...entries: Json[]];

/** Concatenates drafts (see `mergeOperations`). */
export function mergeDrafts(...drafts: DraftOperations[]): DraftOperations {
  const orderedOperations: OrderedOperation[] = [];
  const statePatch: StatePatch = new Map();
  for (const [ordered, patch] of drafts) {
    orderedOperations.push(...ordered);
    for (const [nodeId, state] of patch)
      Object.assign(patchOf(statePatch, nodeId), state);
  }
  return [orderedOperations, statePatch];
}

/** Concatenates batches of operations into one. */
export function mergeOperations(...operationsList: Operations[]): Operations {
  return encodeOperations(mergeDrafts(...operationsList.map(decodeOperations)));
}
