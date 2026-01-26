import type { Doc, DocNode } from "./main.js";
import type { NodeDefinition, StateRecord } from "./types.js";

// lowercase ulid
export const ULID_REGEX = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export function defineNode<T extends string, S extends StateRecord>(
  nodeDefinition: NodeDefinition<T, S>,
) {
  return nodeDefinition;
}

export function detachRange(startNode: DocNode, endNode: DocNode) {
  const oldPrev = startNode.prev;
  const oldNext = endNode.next;
  const oldParent = startNode.parent!;
  if (oldPrev) oldPrev["_set"]("next", oldNext);
  else oldParent["_set"]("first", endNode.next);
  if (oldNext) oldNext["_set"]("prev", oldPrev);
  else oldParent["_set"]("last", startNode.prev);
}

/**
 * Only way to check if an object is empty in O(1)
 * see https://stackoverflow.com/a/59787784/10476393
 */
export function isObjectEmpty(obj: object) {
  for (const _ in obj) return false;
  return true;
}

/**
 * - Starts the tx if it's idle,
 * - Executes the callback,
 * - Rolls back if it fails,
 * - Schedules the commit at the end of the microtask.
 */
export function withTransaction(
  doc: Doc,
  fn: () => void,
  isApplyOperations = false,
): void {
  if (
    doc["_lifeCycleStage"] === "change" ||
    doc["_lifeCycleStage"] === "init" ||
    doc["_lifeCycleStage"] === "disposed"
  )
    throw new Error(
      `You can't trigger an update inside a ${doc["_lifeCycleStage"]} stage`,
    );

  if (doc["_lifeCycleStage"] === "normalize2") {
    throw new Error(
      "Strict mode has caught an error: normalize listeners are not idempotent. I.e, they should not mutate the document on the second pass.",
    );
  }

  const isNewTx = doc["_lifeCycleStage"] === "idle";
  if (isNewTx) {
    doc["_lifeCycleStage"] = "update";
    queueMicrotask(() => {
      // A forceCommit can put the stage into idle mode and there is no need to commit again.
      if (doc["_lifeCycleStage"] === "update") doc.forceCommit();
    });
  }

  try {
    return fn();
  } catch (errorInUpdate) {
    try {
      doc.abort();
    } catch (errorInRevert) {
      /* v8 ignore next -- @preserve */
      console.error("Error applying inverse operations: ", errorInRevert);
    }
    if (!isApplyOperations) throw errorInUpdate;
  }
}
