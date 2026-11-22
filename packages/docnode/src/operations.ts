import { type Doc, type DocNode } from "./main.js";
import { type Json, type UnsafeDefinition } from "./types.js";
import {
  detachRange,
  isObjectEmpty,
  parseJson,
  stringifyJson,
} from "./utils.js";
import { decodeOperations, encodeOperations } from "./wire.js";

export function stringifyStateKey(node: DocNode, key: string): string {
  const resolvedNodeDef = node.doc["_resolvedNodeDefs"].get(node.type)!;
  const stateDefinition = resolvedNodeDef?.state[key];
  if (!(key in node["_state"])) {
    return resolvedNodeDef.defaultStrings[key]!;
  }
  const stateValue = (node as DocNode<UnsafeDefinition>)["_state"][key];
  const stateJson = stateDefinition?.toJSON
    ? stateDefinition.toJSON(stateValue)
    : stateValue;
  const stringified = stringifyJson(stateJson);
  if (stringified === undefined)
    throw new Error(
      `The JSON serialization for state ${key} on a node of type ${node.type} is undefined.`,
    );
  return stringified;
}

export function parseStateKey(
  node: DocNode,
  key: string,
  stringifiedValue: string,
): unknown {
  const stateDef = node.doc["_resolvedNodeDefs"].get(node.type)?.state[key];
  const value = parseJson(stringifiedValue);
  const stateValue = stateDef?.fromJSON(value);
  return stateValue;
}

export const onSetState = {
  operations: (node: DocNode, key: string) => {
    const { doc } = node;
    const statePatchs = doc["_operations"][1];
    const valueString = stringifyStateKey(node, key);

    const prevValueString = doc["_inverseOperations"][1][node.id]?.[key];
    const nodePatch = statePatchs[node.id];
    if (prevValueString === valueString && nodePatch) {
      delete nodePatch[key];
      if (isObjectEmpty(nodePatch)) {
        delete statePatchs[node.id];
        doc["_diff"].updated.delete(node.id);
      }
      delete doc["_inverseOperations"][1][node.id]?.[key];
    } else {
      (statePatchs[node.id] ??= {})[key] = valueString;
      if (!doc["_diff"].inserted.has(node.id))
        doc["_diff"].updated.add(node.id);
    }
  },
  inverseOps: (node: DocNode, key: string) => {
    const { doc } = node;
    const insertedInSameTransaction = doc["_diff"].inserted.has(node.id);
    if (insertedInSameTransaction) return;
    const inverseStatePatchs = doc["_inverseOperations"][1];
    if (inverseStatePatchs[node.id]?.[key] !== undefined) return;
    const originalStringifiedState = stringifyStateKey(node, key);
    (inverseStatePatchs[node.id] ??= {})[key] = originalStringifiedState;
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
  const diff = doc["_diff"];
  doc["_operations"][0].push([
    0,
    nodesOf(nodes),
    newParent === doc.root ? 0 : newParent.id,
    newPrev?.id ?? 0,
    newNext?.id ?? 0,
  ]);
  if (!diff.inserted.has(newParent.id)) {
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

/** `[id, type]` of each node. */
function nodesOf(nodes: readonly DocNode[]): [string, string][] {
  const written: [string, string][] = [];
  for (const node of nodes) written.push([node.id, node.type]);
  return written;
}

/**
 * The descendants of an inserted node, in the order a walk of them finds
 * them: each list of children is inserted when its first child is found.
 */
function onInsertChildren(doc: Doc, parent: DocNode) {
  const first = parent.first;
  if (!first) return;
  copyInsertedToDiff(first);
  const written: [string, string][] = [];
  for (let child: DocNode | undefined = first; child; child = child.next)
    written.push([child.id, child.type]);
  doc["_operations"][0].push([0, written, parent.id, 0, 0]);
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
  // Most transactions that insert delete nothing: no lookup for each node.
  const deletedInSameTransaction =
    diff.deleted.size > 0 && diff.deleted.delete(node.id);
  if (deletedInSameTransaction) {
    diff.moved.add(node.id);
    doc["_diff"].updated.add(node.id);
  } else {
    diff.inserted.add(node.id);
  }
  // [#4GOSK]
  const jsonState = node["_stateToJson"]();
  if (isObjectEmpty(jsonState)) return;
  doc["_operations"][1][node.id] = jsonState;
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
  startNode.to(endNode).forEach((node) => {
    node.descendants({ includeSelf: true }).forEach((node) => {
      delete doc["_operations"][1][node.id];
      doc["_diff"].updated.delete(node.id);
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
  const ordered = operations[0];
  // Up to the length it has now, as `forEach`: undoing a transaction applies
  // the inverse operations it is adding to.
  for (let index = 0, length = ordered.length; index < length; index++) {
    const operation = ordered[index]!;
    switch (operation[0]) {
      case 0:
        // Deleting or moving a missing node skips that operation and keeps
        // applying the batch. Inserting a node that already exists is treated
        // the same way: the intent is already satisfied. Undo steps depend on
        // this when an excluded change restored the node first.
        const nodes: DocNode[] = [];
        for (const [id, type] of operation[1]) {
          if (doc.getNodeById(id)) continue;
          doc["_checkSession"](id);
          nodes.push(doc["_createNodeFromJson"]([id, type, {}]));
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
        try {
          doc
            .getNodeById(operation[1])!
            .to(doc.getNodeById(operation[2] || operation[1])!)
            .delete();
        } catch {}
        break;
      case 2:
        const startNode = doc.getNodeById(operation[1]);
        const endNode = doc.getNodeById(operation[2] || operation[1]);
        if (!startNode || !endNode) break;
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
    }
  }
  // Apply state patch
  const toApplyStatePatch = operations[1];
  const currentStatePatch = doc["_operations"][1];
  const currentInverseStatePatch = doc["_inverseOperations"][1];
  for (const id in toApplyStatePatch) {
    const node: DocNode<UnsafeDefinition> | undefined = doc.getNodeById(id);
    if (!node) continue;
    const insertedInSameTransaction = doc["_diff"].inserted.has(id);
    // Each one read and written once: a patch has a key per node id, each
    // one new to the engine.
    const values = toApplyStatePatch[id]!;
    const state = node["_state"];
    let applied: Record<string, string> | undefined;
    for (const key in values) {
      const value = values[key]!;
      // The state of a node inserted in this transaction is part of its
      // creation and needs no inverse: the inverse operation is a delete.
      if (!insertedInSameTransaction) {
        const current = stringifyStateKey(node, key);
        // A value already in place is treated as applied, like an insert of
        // an existing node. It changes nothing and needs no inverse.
        if (current === value) continue;
        doc["_diff"].updated.add(id);
        (currentInverseStatePatch[id] ??= {})[key] ??= current;
      }
      (applied ??= currentStatePatch[id] ??= {})[key] = value;
      state[key] = parseStateKey(node, key, value);
    }
  }
};

/** Whether the transaction changed something. */
const hasChanges = (doc: Doc) => {
  const { inserted, deleted, moved } = doc["_diff"];
  return (
    inserted.size ||
    deleted.size ||
    moved.size ||
    !isObjectEmpty(doc["_operations"][1])
  );
};

/** We trigger listeners at the end of each update if there were operations (i.e. something changed) */
export const maybeTriggerListeners = (doc: Doc, ignoreEmptyDiff = false) => {
  if (!hasChanges(doc) && !ignoreEmptyDiff) return;
  doc["_lifeCycleStage"] = "normalize";
  const normalizeListeners = doc["_normalizeListeners"];
  if (normalizeListeners.size > 0) {
    normalizeListeners.forEach((listener) => listener({ diff: doc["_diff"] }));
    if (doc["_strictMode"]) {
      doc["_lifeCycleStage"] = "normalize2";
      normalizeListeners.forEach((listener) =>
        listener({ diff: doc["_diff"] }),
      );
    }
  }
  if (!hasChanges(doc)) return;
  doc["_lifeCycleStage"] = "change";
  const listeners = doc["_changeListeners"];
  if (listeners.size === 0) return;
  // Encoded once, for every listener.
  const event = {
    operations: compactOperations(doc["_operations"]),
    inverseOperations: compactOperations(doc["_inverseOperations"]),
    diff: doc["_diff"],
    flags: doc["_transactionFlags"],
  };
  listeners.forEach((listener) => listener(event));
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
    const inversePatchState = doc["_inverseOperations"][1][node.id];
    const currentState = node["_stateToJson"]();
    const previousState = { ...currentState, ...inversePatchState };
    doc["_inverseOperations"][1][node.id] = previousState;
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

type MoveOperation = [
  operation: 2,
  start: string,
  end: string | 0,
  parent: string | 0,
  prev: string | 0,
  next: string | 0,
];

export type OrderedOperation =
  | InsertOperation
  | DeleteOperation
  | MoveOperation;

// TODO: not implemented yet
// type ChangeTypeOperation = [
//   operation: 3,
//   type: string,
//   start: string,
//   end: string | 0,
//   includeDescendants: 1 | 0,
// ]

/** The new value of each changed key of each node, as a JSON string. */
export type StatePatch = { [id: string]: Record<string, string> };

/**
 * A node in a batch: `"index.clock"` when its id is `session.clock` (the
 * session by its index in the head, `""` for the first), else its id, with a
 * `!` in front if it starts with one or is an integer. A node of the head's
 * own session can instead be written by its clock's distance from the head's
 * counter (see `wire.ts`), a number. `0` is none: the root as a parent, or no
 * sibling.
 */
export type NodeRef = string | number;

/**
 * `[0, nodes, parent?, prev?, next?]`: inserts `nodes` (`[id, type]` each)
 * under `parent`, between two siblings. Trailing zeros are left out.
 */
export type InsertNodesRow = readonly [
  op: 0,
  /** A count is a run of nodes, each one right after the one before. */
  nodes: readonly (
    | readonly [id: NodeRef, type: string]
    | readonly [id: NodeRef, type: string, count: number]
  )[],
  ...parentPrevNext: NodeRef[],
];

/** `[1, start, end?]`: deletes the nodes from `start` to `end`. */
export type DeleteNodesRow = readonly [
  op: 1,
  start: NodeRef,
  ...end: NodeRef[],
];

/**
 * `[2, start, end?, parent?, prev?, next?]`: moves the nodes from `start` to
 * `end` under `parent`, between two siblings.
 */
export type MoveNodesRow = readonly [
  op: 2,
  start: NodeRef,
  ...endParentPrevNext: NodeRef[],
];

/**
 * `[-9, node, key, value, ...]`: the new value of each changed key of each
 * node, as JSON, always the last row. `[node, count]` in place of a node is
 * `count` nodes one after the other, and its value a column, one per node.
 */
export type StatePatchRow = readonly [op: -9, ...entries: Json[]];

export type OperationsRow =
  | InsertNodesRow
  | DeleteNodesRow
  | MoveNodesRow
  | StatePatchRow;

/** A row that a batch of only that row writes without its brackets. */
export type FlatRow =
  | InsertNodesRow
  | DeleteNodesRow
  | MoveNodesRow
  | StatePatchRow;

/**
 * The sessions of the batch: `"session.clock"`, with the clock of its first
 * node of that session, or `["session.clock", ...others]`.
 */
export type Head = string | readonly string[];

/**
 * A batch of operations as it travels and is stored, read on its own: see
 * `wire.ts`. A batch of one row leaves out its brackets. For example,
 * deleting a node: `["Q14_wOXyP.uiW",1,1]`.
 */
export type Operations =
  | readonly [head: Head, ...rows: OperationsRow[]]
  | readonly [head: Head, ...row: FlatRow];

/** Operations while they are built and applied: the patch is always there. */
export type DraftOperations = [OrderedOperation[], StatePatch];

export const compactOperations = (operations: DraftOperations): Operations =>
  encodeOperations(operations[0], operations[1]);

/** Concatenates batches. */
export function mergeDrafts(...drafts: DraftOperations[]): DraftOperations {
  const orderedOperations: OrderedOperation[] = [];
  const statePatch: StatePatch = {};
  for (const [ordered, patch] of drafts) {
    orderedOperations.push(...ordered);
    for (const nodeId in patch) {
      statePatch[nodeId] ??= {};
      Object.assign(statePatch[nodeId], patch[nodeId]);
    }
  }
  return [orderedOperations, statePatch];
}

/** Concatenates batches of operations into one. */
export function mergeOperations(...operationsList: Operations[]): Operations {
  return compactOperations(
    mergeDrafts(...operationsList.map(decodeOperations)),
  );
}
