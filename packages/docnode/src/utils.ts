import type { Doc, DocNode } from "./main.js";
import type { Json, StateRecord } from "./types.js";

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

const isList = (json: Json): json is readonly Json[] => Array.isArray(json);

/**
 * Whether state values are frozen, as Yjs does with the values it stores
 * (`ContentAny.js`): stored documents and the live state share objects, so a
 * value changed in place, instead of with `set`, would change the document
 * without an operation. Freezing makes that throw outside production.
 *
 * `process.env.NODE_ENV` is written literally so that bundlers replace it:
 * in a browser build it is on in development and gone in production.
 */
const FREEZE =
  typeof process !== "undefined" && process.env.NODE_ENV !== "production";

/** Freezes `value` and the plain objects and lists in it (see `FREEZE`). */
export function freezeInDev<V>(value: V): V {
  /* v8 ignore if -- @preserve */
  if (!FREEZE) return value;
  deepFreeze(value);
  return value;
}

function deepFreeze(value: unknown) {
  if (typeof value !== "object" || !value || Object.isFrozen(value)) return;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype) return;
  Object.freeze(value);
  for (const key in value) {
    const item: unknown = Reflect.get(value, key);
    deepFreeze(item);
  }
}

/** Whether two JSON values are equal. */
export function equalJson(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || !a) return false;
  if (typeof b !== "object" || !b) return false;
  if (isList(a)) {
    if (!isList(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equalJson(a[i], b[i])) return false;
    return true;
  }
  if (isList(b)) return false;
  let count = 0;
  for (const key in a) {
    if (!(key in b) || !equalJson(a[key], b[key])) return false;
    count++;
  }
  for (const _ in b) count--;
  return count === 0;
}
