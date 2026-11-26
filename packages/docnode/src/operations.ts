import { type Doc, type DocNode } from "./main.js";
import {
  type Json,
  type StateDefinition,
  type UnsafeDefinition,
} from "./types.js";
import { detachRange, freezeInDev, isObjectEmpty } from "./utils.js";

/**
 * The JSON of a node's state value, as its definition's `toJSON` writes it,
 * or of the default when the key was never set. It is the value itself, not
 * a copy: state values are not changed in place (they are frozen in
 * development).
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
 * Date, a class) is what `JSON.stringify` writes of it, so that a stored
 * document stays the same through `structuredClone` (IndexedDB).
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

export function parseStateKey(
  node: DocNode,
  key: string,
  stringifiedValue: string,
): unknown {
  const stateDef = node.doc["_resolvedNodeDefs"].get(node.type)?.state[key];
  const value = JSON.parse(stringifiedValue) as Json;
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
  const deletedInSameTransaction = diff.deleted.delete(node.id);
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

export const onApplyOperations = (doc: Doc, operations: Operations) => {
  operations[0].forEach((operation) => {
    switch (operation[0]) {
      case 0:
        // Deleting or moving a missing node skips that operation and keeps
        // applying the batch. Inserting a node that already exists is treated
        // the same way: the intent is already satisfied. Undo steps depend on
        // this when an excluded change restored the node first.
        const nodes = operation[1]
          .filter(([id]) => !doc.getNodeById(id))
          .map(([id, type]) => doc["_insertedNode"](id, type));
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
  });
  // Apply state patch
  const toApplyStatePatch = operations[1];
  const currentStatePatch = doc["_operations"][1];
  const currentInverseStatePatch = doc["_inverseOperations"][1];
  for (const id in toApplyStatePatch) {
    const node = doc.getNodeById(id);
    if (!node) continue;
    const insertedInSameTransaction = doc["_diff"].inserted.has(id);
    for (const key in toApplyStatePatch[id]) {
      const value = toApplyStatePatch[id][key]!;
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
      (currentStatePatch[id] ??= {})[key] = value;
      node["_values"]()[key] = freezeInDev(parseStateKey(node, key, value));
    }
  }
};

/** We trigger listeners at the end of each update if there were operations (i.e. something changed) */
export const maybeTriggerListeners = (doc: Doc, ignoreEmptyDiff = false) => {
  const hasChanges = () => {
    const { inserted, deleted, moved } = doc["_diff"];
    return (
      inserted.size ||
      deleted.size ||
      moved.size ||
      !isObjectEmpty(doc["_operations"][1])
    );
  };
  if (!hasChanges() && !ignoreEmptyDiff) return;
  doc["_lifeCycleStage"] = "normalize";
  doc["_normalizeListeners"].forEach((listener) =>
    listener({ diff: doc["_diff"] }),
  );
  if (doc["_strictMode"]) {
    doc["_lifeCycleStage"] = "normalize2";
    doc["_normalizeListeners"].forEach((listener) =>
      listener({ diff: doc["_diff"] }),
    );
  }
  if (!hasChanges()) return;
  doc["_lifeCycleStage"] = "change";
  doc["_changeListeners"].forEach((listener) =>
    listener({
      operations: doc["_operations"],
      inverseOperations: doc["_inverseOperations"],
      diff: doc["_diff"],
      flags: doc["_transactionFlags"],
    }),
  );
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

type StatePatch = { [id: string]: Record<string, string> };

export type Operations = readonly [OrderedOperation[], StatePatch];

export function mergeOperations(...operationsList: Operations[]): Operations {
  const orderedOperations: OrderedOperation[] = [];
  const statePatch: StatePatch = {};

  for (const operations of operationsList) {
    orderedOperations.push(...operations[0]);
    for (const nodeId in operations[1]) {
      statePatch[nodeId] ??= {};
      Object.assign(statePatch[nodeId], operations[1][nodeId]);
    }
  }

  return [orderedOperations, statePatch];
}
