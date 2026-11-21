import { type Doc, type DocNode } from "./main.js";
import { type Json, type UnsafeDefinition } from "./types.js";
import {
  detachRange,
  isObjectEmpty,
  parseJson,
  stringifyJson,
} from "./utils.js";
import { fuseTextInserts } from "./text/merge.js";
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
          nodes.push(doc["_newStoredNode"](id, type));
        }
        if (nodes.length === 0) break;
        // A sibling anchor counts while it is still in the parent the author
        // saw: one a concurrent change took elsewhere would take the nodes
        // with it, maybe into a node deleted later.
        const parent = operation[2] ? doc.getNodeById(operation[2]) : doc.root;
        const prev = operation[3] ? doc.getNodeById(operation[3]) : undefined;
        if (prev && prev.parent === parent) {
          doc["_insertRange"](prev, "after", nodes);
          break;
        }
        const next = operation[4] ? doc.getNodeById(operation[4]) : undefined;
        if (next && next.parent === parent) {
          doc["_insertRange"](next, "before", nodes);
          break;
        }
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
          else if (prevNode?.parent === parentNode)
            startNode.to(endNode).move(prevNode, "after");
          else if (nextNode?.parent === parentNode)
            startNode.to(endNode).move(nextNode, "before");
          else startNode.to(endNode).move(parentNode, "append");
        } catch {}
        break;
      case 3: {
        // Edit operation of an opt-in state kind. The value lives on the root.
        const key = doc["_editStateKey"];
        const definition = doc["_editDefinition"];
        if (key === undefined || !definition?.applyEdit) break;
        const root: DocNode<UnsafeDefinition> = doc.root;
        const value = root["_state"][key];
        const inverse = definition.applyEdit(value, doc, operation);
        if (inverse === undefined) break;
        doc["_operations"][0].push(operation);
        doc["_inverseOperations"][0].push(inverse);
        doc["_hasEdits"] = true;
        break;
      }
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
    doc["_hasEdits"] ||
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
  const event = doc["_event"] ?? {
    operations: receivedAsIs(doc) ?? compactOperations(doc["_operations"]),
    inverseOperations: compactOperations(doc["_inverseOperations"]),
    diff: doc["_diff"],
    flags: doc["_transactionFlags"],
  };
  listeners.forEach((listener) => listener(event));
};

/**
 * The batch the transaction applied, when its operations are exactly those it
 * decoded to: a batch received is passed on as it came, without encoding it
 * again. The event gets its own array: a listener that changes it does not
 * change the batch passed to `applyOperations`, nor the other way around. No
 * one changes a row, so they are shared.
 */
function receivedAsIs(doc: Doc): Operations | undefined {
  const received = doc["_received"];
  const draft = doc["_decoded"];
  if (!received || !draft) return undefined;
  const [ordered, patch] = doc["_operations"];
  const [decoded, decodedPatch] = draft;
  if (ordered.length !== decoded.length) return undefined;
  for (let index = 0; index < ordered.length; index++)
    if (ordered[index] !== decoded[index]) return undefined;
  if (!isObjectEmpty(patch) || !isObjectEmpty(decodedPatch)) return undefined;
  const [head, ...rows] = received;
  return [head, ...rows];
}

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

/**
 * Edit of a state kind that does not replicate as one absolute value per key.
 * The payload follows the kind and is opaque to the core, except that
 * `mergeOperations` fuses adjacent text insertions. Unlike the other kinds, it
 * must be idempotent and must not depend on the order of arrival.
 */
export type EditOperation = [operation: 3, ...payload: Json[]];

export type OrderedOperation =
  | InsertOperation
  | DeleteOperation
  | MoveOperation
  | EditOperation;

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
 * A letter in a text row: of the row's own session, a number (the distance
 * back from the row's counter, or for an insert's right origin its counter +
 * 1, negative when the insert is its left child), or `"'"`, the last letter
 * written again; of another session, `"index.counter"`; the start of a
 * node's text, `"^node"`. `0` is none.
 */
export type LetterRef = string | number;

/**
 * `[0, nodes, parent?, prev?, next?]`: inserts `nodes` (`[id, type]` each)
 * under `parent`, between two siblings. Trailing zeros are left out.
 */
export type InsertNodesRow =
  | readonly [
      op: 0,
      /** A count is a run of nodes, each one right after the one before. */
      nodes: readonly (
        | readonly [id: NodeRef, type: string]
        | readonly [id: NodeRef, type: string, count: number]
      )[],
      ...parentPrevNext: NodeRef[],
    ]
  /** One node, without the list. */
  | readonly [op: 0, id: NodeRef, type: string, ...parentPrevNext: NodeRef[]];

/**
 * `[1, start, end?]`: deletes the nodes from `start` to `end`. `[1]` is the
 * node at the head's clock.
 */
export type DeleteNodesRow = readonly [op: 1, ...startEnd: NodeRef[]];

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
 * `[content, right?, parent?]`: inserts letters (`text`, or `[text,
 * ...state]` with their first state) at the row's counter, before `right`,
 * and after the letter typed before it unless `parent` says otherwise.
 * Inserts one after the other share a row: `[text, ...refs, text, ...refs]`.
 */
export type InsertTextRow = readonly [
  /** The letters, or `[letters, attrs]` with their first state. */
  content: string | readonly Json[],
  ...rightParent: LetterRef[],
];

/**
 * `[text, ids, ...]`: inserts letters with the ids a delete took from them
 * (an undo of the delete), see `text/baseText.ts`.
 */
export type InsertTextAgainRow = readonly [
  text: string,
  ids: readonly Json[],
  ...rest: Json[],
];

/** Any other text edit: `-tag` (`-(tag + 10)` when it undoes an insert), then its payload. */
export type EditTextRow = readonly [tag: number, ...payload: Json[]];

/** `"index.counter"`: the text rows after it are of that session, from that counter. */
export type SessionRow = string;

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
  | InsertTextRow
  | InsertTextAgainRow
  | EditTextRow
  | SessionRow
  | StatePatchRow;

/** A row that a batch of only that row writes without its brackets. */
export type FlatRow =
  | InsertNodesRow
  | DeleteNodesRow
  | MoveNodesRow
  | EditTextRow
  | StatePatchRow;

/**
 * The sessions of the batch: `"session.counter"`, with the counter of its
 * first text row, or `["session.counter", ...others]`.
 */
export type Head = string | readonly string[];

/**
 * A batch of operations as it travels and is stored, read on its own: see
 * `wire.ts`. A batch of one row (but a text insert) leaves out its brackets.
 * For example, typing a letter between two others: `["Q14_wOXyP.uiW","s",
 * -87638]`.
 */
export type Operations =
  | readonly [head: Head, ...rows: OperationsRow[]]
  | readonly [head: Head, ...row: FlatRow]
  | readonly [head: Head, content: string, ...rightParent: LetterRef[]]
  | readonly [head: Head, ...row: InsertTextAgainRow];
  // A CRDT engine's row (a tag of 3 or more), then one row without brackets.
  | readonly [head: Head, engine: EditTextRow, ...row: FlatRow]
  | readonly [
      head: Head,
      engine: EditTextRow,
      content: string,
      ...rightParent: LetterRef[],
    ];

/** Operations while they are built and applied: the patch is always there. */
export type DraftOperations = [OrderedOperation[], StatePatch];

export const compactOperations = (operations: DraftOperations): Operations =>
  encodeOperations(operations[0], operations[1]);

/** Concatenates batches, fusing text insertions typed one after the other. */
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
  return [fuseTextInserts(orderedOperations), statePatch];
}

/**
 * Concatenates batches of operations into one. Text insertions typed one after
 * the other are fused into a single insertion.
 */
export function mergeOperations(...operationsList: Operations[]): Operations {
  return compactOperations(
    mergeDrafts(...operationsList.map(decodeOperations)),
  );
}

/**
 * Whether a batch only edits text: no row of a CRDT engine (right after the
 * head, an array or a flat row that starts with 3 or more), no node inserted,
 * deleted or moved, and no state.
 */
function isTextOnly(batch: Operations): boolean {
  const first: unknown = batch[1];
  const tag: unknown = Array.isArray(first) ? first[0] : first;
  if (typeof tag === "number" && tag >= 3) return false;
  const [ordered, patch] = decodeOperations(batch);
  return isObjectEmpty(patch) && ordered.every((op) => op[0] === 3);
}

/**
 * Consecutive batches of one writer, with each run of batches that only edit
 * text merged into one (see `mergeOperations`): typing sends one batch per
 * letter, and their merge is one insert of all of them. Applying the result
 * in order changes a document as applying `batches` in order does. Any
 * other batch is kept as it is.
 */
export function mergeBatches(batches: readonly Operations[]): Operations[] {
  const merged: Operations[] = [];
  let run: Operations[] = [];
  const flush = () => {
    if (run.length > 1) merged.push(mergeOperations(...run));
    else merged.push(...run);
    run = [];
  };
  for (const batch of batches) {
    if (isTextOnly(batch)) {
      run.push(batch);
      continue;
    }
    flush();
    merged.push(batch);
  }
  flush();
  return merged;
}
