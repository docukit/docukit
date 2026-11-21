import type { Doc, DocNode } from "./main.js";
import type { Json, StateRecord } from "./types.js";
import type { StatePatch } from "./operations.js";

// lowercase ulid
export const ULID_REGEX = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

export function defineNode<
  T extends string,
  S extends StateRecord,
>(nodeDefinition: { type: T; state?: S }) {
  return { state: {} as S, ...nodeDefinition };
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
 * An empty state patch. V8 gives every new key of an object a new hidden
 * class, and node ids are new each time: an object whose keys were deleted
 * keeps them in a dictionary instead.
 */
export function idRecord(): StatePatch {
  // One deleted key is enough.
  const patch: StatePatch = { a: {} };
  delete patch.a;
  return patch;
}

/** `JSON.parse` without a reviver, which always gives JSON. */
const parse: (text: string) => Json = JSON.parse;

/**
 * `JSON.parse` of a value's JSON text. A number, the value sent most, is
 * read without it: `Number` reads JSON number text the same way.
 */
export function parseJson(text: string): Json {
  const code = text.charCodeAt(0);
  return code === 45 || (code >= 48 && code <= 57) ? Number(text) : parse(text);
}

/**
 * `JSON.stringify` of a value; a finite number without it, which `String`
 * writes the same way.
 */
export function stringifyJson(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : JSON.stringify(value);
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
    // One commit pending at a time: a transaction committed early (forceCommit)
    // leaves its microtask to the next one.
    if (!doc["_commitScheduled"]) {
      doc["_commitScheduled"] = true;
      queueMicrotask(() => {
        doc["_commitScheduled"] = false;
        // A forceCommit can put the stage into idle mode and there is no need to commit again.
        if (doc["_lifeCycleStage"] === "update") doc.forceCommit();
      });
    }
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
