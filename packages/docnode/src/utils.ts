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
 * Orders two Lamport stamps `(clock, session)`: by clock, then session. The
 * greater one wins a write, in the labels engine and in letter states.
 */
export const compareStamps = (
  clock: number,
  session: string,
  otherClock: number,
  otherSession: string,
) =>
  clock - otherClock ||
  Number(session > otherSession) - Number(session < otherSession);

/**
 * Where a new kid goes among FugueMax kids, sorted: the index of the first one
 * `before` says it sorts before. The end is checked first: elements made in
 * order go last. Shared by the letters and by the places of the labels engine.
 */
export function kidIndex<T>(
  kids: readonly T[],
  before: (kid: T) => boolean,
): number {
  let high = kids.length;
  if (high === 0 || !before(kids[high - 1]!)) return high;
  let low = 0;
  high--;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (before(kids[mid]!)) high = mid;
    else low = mid + 1;
  }
  return low;
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
 * What `JSON.parse(JSON.stringify(value))` gives, without the text in
 * between, or `undefined` where `JSON.stringify` writes nothing. `key` is
 * what a `toJSON` method receives. A stored document is made of these, and
 * on a big document the text was most of the time of a save.
 *
 * A value that `JSON.stringify` cannot write (a cycle, a BigInt) never gets
 * here: its operation, which writes it, throws first.
 */
export function jsonCopy(value: unknown, key = ""): Json | undefined {
  if (typeof value === "object" && value !== null) {
    const toJSON: unknown = Reflect.get(value, "toJSON");
    if (typeof toJSON === "function") {
      const json: unknown = Reflect.apply(toJSON, value, [key]);
      value = json;
    }
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      // `-0` is written `0`; `NaN` and the infinities, `null`.
      return Number.isFinite(value) ? value + 0 : null;
    case "object":
      break;
    default:
      return undefined;
  }
  if (value === null) return null;
  if (
    value instanceof Number ||
    value instanceof String ||
    value instanceof Boolean
  )
    return jsonCopy(value.valueOf(), key);
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    const out: Json[] = [];
    for (let index = 0; index < items.length; index++)
      out.push(jsonCopy(items[index], String(index)) ?? null);
    return out;
  }
  const out: { [key: string]: Json } = {};
  for (const name of Object.keys(value)) {
    const item = jsonCopy(Reflect.get(value, name), name);
    if (item === undefined) continue;
    // An own key, as `JSON.parse` makes it, not the prototype.
    if (name === "__proto__")
      Object.defineProperty(out, name, {
        value: item,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    else out[name] = item;
  }
  return out;
}

const isJsonList = (json: Json): json is readonly Json[] => Array.isArray(json);

/** Whether two JSON values are written the same by `JSON.stringify`. */
export function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (isJsonList(a))
    return (
      isJsonList(b) &&
      a.length === b.length &&
      a.every((item, index) => jsonEqual(item, b[index]!))
    );
  if (isJsonList(b)) return false;
  const keys = Object.keys(a);
  const others = Object.keys(b);
  return (
    keys.length === others.length &&
    keys.every(
      (name, index) => name === others[index] && jsonEqual(a[name]!, b[name]!),
    )
  );
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
      console.error("Error applying inverse operations: ", errorInRevert);
    }
    if (!isApplyOperations) throw errorInUpdate;
  }
}
