import type {
  DraftOperations,
  NodeRef,
  Operations,
  OperationsRow,
  OrderedOperation,
  OrderedRow,
  PatchRow,
  StatePatch,
} from "./operations.js";
import type { Json } from "./types.js";
import { MAX_CLOCK, clockAt, numberToBase64 } from "./idGenerator.js";
import { patchOf } from "./operations.js";
import { ownId, ownKey } from "./utils.js";

// `Operations`, a batch as it travels and is stored, is `[head, ...rows]`,
// plain JSON read on its own:
//
// - `head` is the id of the first node of the form `session.clock` that the
//   batch names, or "" if none. A node of its session is written as a number:
//   its clock's distance `d` from the head's, `d + 1` from 0 on and `d` below
//   (`1` is the head's node, `-1` the one before). Any other node is its whole
//   id, a string. `0` is none: the root as a parent, or no sibling. Like Yjs,
//   which writes a client once for its structs and each clock from the first
//   (`writeStructs`), a session is written once; the distance makes a batch
//   that inserts after the node its author inserted before write the same
//   rows each time, which the gzip of a stream of batches removes.
// - `[0, nodes, parent, prev, next]`, `[1, start, end]` and `[2, start, end,
//   parent, prev, next]` insert, delete and move nodes, as `OrderedOperation`,
//   without their trailing zeros. `nodes` has `[node, type]` for each node, or
//   `[node, type, count]` for `count` nodes of a type, each made right after
//   the one before (like a run of Yjs structs, or of ids in a stored
//   document). One node is inserted as `[0, node, type, parent, prev, next]`,
//   without the list.
// - The state patch, if any, is the last row: `[-9, node, key, value, ...]`,
//   a triple per key a node changed, the value as JSON. `[node, count], key,
//   values` sets `key` on `count` nodes one right after the other, a value
//   each, so an insert of many nodes writes each key once. A number node,
//   alone or first of a run, is its difference from the number node before
//   it in the row (from 0), as Automerge's delta columns and lib0's
//   `IntDiffOptRleEncoder` write ids.
// - A batch of one row that is not a state patch is written without the
//   row's brackets: `[head, 1, 1]` deletes the head's node.

/** The tag of the state patch row. */
const PATCH = -9;

/** The clock of `id` if it is `session.clock` (see `clockAt`), else -1. */
const clockOf = (id: string) => clockAt(id, id.lastIndexOf("."));

/** Whether `next` is the node made right after `id`: same session, next clock. */
function follows(id: string, next: string) {
  const dot = id.lastIndexOf(".");
  const clock = clockAt(id, dot);
  return (
    clock >= 0 &&
    next.lastIndexOf(".") === dot &&
    clockAt(next, dot) === clock + 1 &&
    next.startsWith(id.slice(0, dot))
  );
}

/** The first node id of the form `session.clock` that a draft names. */
function headOf(draft: DraftOperations) {
  for (const op of draft[0]) {
    const first = op[0] === 0 ? op[1][0]![0] : op[1];
    if (clockOf(first) >= 0) return first;
  }
  for (const id of draft[1].keys()) if (clockOf(id) >= 0) return id;
  return "";
}

// The functions below take the head's parts as arguments and read rows by
// index: a closure per batch, a rest copy or a destructuring (which runs an
// iterator) would be garbage of every transaction.

/**
 * `id` as a batch with a head of `prefix` and `base` writes it (`dot` is where
 * the head's clock starts, and `base` is -1 if the batch has no head).
 */
function refOf(
  id: string | 0,
  prefix: string,
  dot: number,
  base: number,
): NodeRef {
  if (id === 0 || base < 0 || !id.startsWith(prefix)) return id;
  // -1 for a clock with a dot or one that would not be written back the same.
  const clock = clockAt(id, dot);
  if (clock < 0) return id;
  return clock >= base ? clock - base + 1 : clock - base;
}

/** `row` without its trailing zeros: the part after its tag is never 0. */
function trimmed<Row extends unknown[]>(row: Row): Row {
  while (row.length > 2 && row[row.length - 1] === 0) row.pop();
  return row;
}

/** An ordered operation as a row of a batch (see the format above). */
function rowOf(
  op: OrderedOperation,
  prefix: string,
  dot: number,
  base: number,
): OrderedRow {
  if (op[0] === 1) {
    const row: [1, NodeRef, NodeRef?] = [
      1,
      refOf(op[1], prefix, dot, base),
      refOf(op[2], prefix, dot, base),
    ];
    return trimmed(row);
  }
  if (op[0] === 2) {
    const row: [2, NodeRef, NodeRef?, NodeRef?, NodeRef?, NodeRef?] = [
      2,
      refOf(op[1], prefix, dot, base),
      refOf(op[2], prefix, dot, base),
      refOf(op[3], prefix, dot, base),
      refOf(op[4], prefix, dot, base),
      refOf(op[5], prefix, dot, base),
    ];
    return trimmed(row);
  }
  const list = op[1];
  const parent = refOf(op[2], prefix, dot, base);
  const prev = refOf(op[3], prefix, dot, base);
  const next = refOf(op[4], prefix, dot, base);
  if (list.length === 1) {
    const row: [0, NodeRef, string, NodeRef?, NodeRef?, NodeRef?] = [
      0,
      refOf(list[0]![0], prefix, dot, base),
      list[0]![1],
      parent,
      prev,
      next,
    ];
    return trimmed(row);
  }
  const nodes: ([NodeRef, string] | [NodeRef, string, number])[] = [];
  for (let at = 0; at < list.length; ) {
    const id = list[at]![0];
    const type = list[at]![1];
    let count = 1;
    while (
      at + count < list.length &&
      list[at + count]![1] === type &&
      follows(list[at + count - 1]![0], list[at + count]![0])
    )
      count++;
    const ref = refOf(id, prefix, dot, base);
    nodes.push(count > 1 ? [ref, type, count] : [ref, type]);
    at += count;
  }
  const row: [0, typeof nodes, NodeRef?, NodeRef?, NodeRef?] = [
    0,
    nodes,
    parent,
    prev,
    next,
  ];
  return trimmed(row);
}

/** Whether `state` has `keys`, in that order, and no other. */
function hasKeys(state: Record<string, Json>, keys: readonly string[]) {
  let index = 0;
  for (const key in state) if (keys[index++] !== key) return false;
  return index === keys.length;
}

/**
 * How many patch entries from `at` on are nodes one right after the other
 * with the same keys, which the patch can write as a run.
 */
function runLength(
  ids: readonly string[],
  states: readonly Record<string, Json>[],
  at: number,
) {
  let keys: string[] | undefined;
  let length = 1;
  while (
    at + length < ids.length &&
    follows(ids[at + length - 1]!, ids[at + length]!) &&
    hasKeys(states[at + length]!, (keys ??= Object.keys(states[at]!)))
  )
    length++;
  return length;
}

/** The state patch row of a draft (see the format above), if it has one. */
function patchRowOf(
  patch: StatePatch,
  prefix: string,
  dot: number,
  base: number,
): PatchRow | undefined {
  const ids: string[] = [];
  const states: Record<string, Json>[] = [];
  for (const [id, state] of patch) {
    ids.push(id);
    states.push(state);
  }
  const row: [typeof PATCH, ...Json[]] = [PATCH];
  // A number node as its difference from the one before (see the format).
  let last = 0;
  for (let at = 0; at < ids.length; ) {
    const node = refOf(ids[at]!, prefix, dot, base);
    const state = states[at]!;
    const length = runLength(ids, states, at);
    for (const key in state) {
      const written = typeof node === "number" ? node - last : node;
      if (typeof node === "number") last = node;
      // A run: a list of values, one per node from the first on.
      if (length === 1) row.push(written, key, state[key]!);
      else row.push([written, length], key, valuesOf(states, at, length, key));
    }
    at += length;
  }
  return row.length > 1 ? row : undefined;
}

/** The value of `key` in each of `length` states from `at` on. */
function valuesOf(
  states: readonly Record<string, Json>[],
  at: number,
  length: number,
  key: string,
) {
  const values: Json[] = [];
  for (let i = at; i < at + length; i++) values.push(states[i]![key]!);
  return values;
}

/** A draft as it travels (see the format above). */
export function encodeOperations(draft: DraftOperations): Operations {
  const head = headOf(draft);
  const dot = head.lastIndexOf(".");
  const base = clockAt(head, dot);
  const prefix = head.slice(0, dot + 1);
  const ordered = draft[0];
  const patch = patchRowOf(draft[1], prefix, dot, base);
  // One row without its brackets (see the format).
  if (ordered.length === 1 && !patch)
    return [head, ...rowOf(ordered[0]!, prefix, dot, base)];
  const rows: [string, ...OperationsRow[]] = [head];
  for (const op of ordered) rows.push(rowOf(op, prefix, dot, base));
  if (patch) rows.push(patch);
  return rows;
}

/** The most nodes a batch may insert, so that a broken one cannot hang. */
const MAX_BATCH_NODES = 1_000_000;

/** Whether a part of a batch is a list. */
const isList = (part: Json | undefined): part is readonly Json[] =>
  Array.isArray(part);

/** Whether a row of a batch is a list, as a row is. */
const isRow = (row: string | OperationsRow | undefined): row is OperationsRow =>
  Array.isArray(row);

/** Whether a batch is one row without its brackets (see the format above). */
const isFlat = (
  operations: Operations,
): operations is readonly [head: string, ...row: OrderedRow] =>
  typeof operations[1] === "number";

/** A batch that does not follow the format above. */
const invalid = (why: string) => new Error(`Invalid operations: ${why}.`);

/** `inserted` plus `more` nodes, if a batch may insert them. */
function counted(inserted: number, more: number) {
  inserted += more;
  if (inserted > MAX_BATCH_NODES)
    throw invalid(`it inserts more than ${MAX_BATCH_NODES} nodes`);
  return inserted;
}

/** The whole id of `ref`, in a batch with a head of `prefix` and `base`. */
function nodeOf(ref: Json | undefined, prefix: string, base: number): string {
  if (typeof ref === "string") return ownId(ref);
  if (typeof ref === "number" && base >= 0 && Number.isInteger(ref)) {
    const clock = ref > 0 ? base + ref - 1 : base + ref;
    if (ref !== 0 && clock >= 0 && clock <= MAX_CLOCK)
      return prefix + numberToBase64(clock);
  }
  throw invalid(`${JSON.stringify(ref)} is not a node of the head's session`);
}

/** Like `nodeOf`, but `0` or a left out node (none) is `0`. */
function idOf(ref: Json | undefined, prefix: string, base: number) {
  return ref === 0 || ref === undefined ? 0 : nodeOf(ref, prefix, base);
}

/**
 * Throws unless `count` nodes from `first`, at `clock`, are a run: nodes of
 * a session one right after the other.
 */
function assertRun(
  first: string,
  clock: number,
  count: Json | undefined,
): asserts count is number {
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 2 ||
    clock < 0 ||
    clock + count - 1 > MAX_CLOCK
  )
    throw invalid(`a run of ${JSON.stringify(count)} nodes from '${first}'`);
}

/**
 * Adds to `ordered` the operation of the row that starts at `row[at]` (the
 * `index`th of the batch), and returns `inserted` plus the nodes it inserts.
 */
function readRow(
  row: readonly (Json | undefined)[],
  at: number,
  index: number,
  prefix: string,
  base: number,
  ordered: OrderedOperation[],
  inserted: number,
): number {
  const tag = row[at];
  // Where the row's last item may be: one past it is too many.
  let end: number;
  if (tag === 0) {
    const nodes: [string, string][] = [];
    const list = row[at + 1];
    // Where the parent is: after the list, or after a node and its type.
    let to = at + 2;
    if (!isList(list)) {
      const type = row[at + 2];
      if (typeof type !== "string")
        throw invalid(`its row ${index} is not an operation`);
      nodes.push([nodeOf(list, prefix, base), type]);
      inserted = counted(inserted, 1);
      to++;
    } else {
      if (list.length === 0)
        throw invalid(`its row ${index} is not an operation`);
      for (const entry of list) {
        if (!isList(entry) || entry.length > 3 || typeof entry[1] !== "string")
          throw invalid(`its row ${index} is not an operation`);
        const type = entry[1];
        const first = nodeOf(entry[0], prefix, base);
        nodes.push([first, type]);
        if (entry.length === 2) {
          inserted = counted(inserted, 1);
          continue;
        }
        // A run: the nodes after the first, in its session.
        const firstDot = first.lastIndexOf(".");
        const session = first.slice(0, firstDot + 1);
        const clock = clockAt(first, firstDot);
        const count = entry[2];
        assertRun(first, clock, count);
        inserted = counted(inserted, count);
        for (let i = 1; i < count; i++)
          nodes.push([session + numberToBase64(clock + i), type]);
      }
    }
    ordered.push([
      0,
      nodes,
      idOf(row[to], prefix, base),
      idOf(row[to + 1], prefix, base),
      idOf(row[to + 2], prefix, base),
    ]);
    end = to + 2;
  } else if (tag === 1) {
    ordered.push([
      1,
      nodeOf(row[at + 1], prefix, base),
      idOf(row[at + 2], prefix, base),
    ]);
    end = at + 2;
  } else if (tag === 2) {
    ordered.push([
      2,
      nodeOf(row[at + 1], prefix, base),
      idOf(row[at + 2], prefix, base),
      idOf(row[at + 3], prefix, base),
      idOf(row[at + 4], prefix, base),
      idOf(row[at + 5], prefix, base),
    ]);
    end = at + 5;
  } else throw invalid(`its row ${index} is not an operation`);
  if (row.length > end + 1)
    throw invalid(`its row ${index} has items after its operation`);
  return inserted;
}

/** The state patch of a patch row (see the format above). */
function readPatch(
  row: readonly Json[],
  prefix: string,
  base: number,
): StatePatch {
  if ((row.length - 1) % 3 !== 0)
    throw invalid("its state patch is not triples of node, key and value");
  const patch: StatePatch = new Map();
  let last = 0;
  for (let at = 1; at < row.length; at += 3) {
    let ref = row[at];
    const key = row[at + 1];
    const value = row[at + 2]!;
    if (typeof key !== "string")
      throw invalid("its state patch has a key that is not a string");
    ownKey(key);
    if (!isList(ref)) {
      if (typeof ref === "number") last = ref += last;
      patchOf(patch, nodeOf(ref, prefix, base))[key] = value;
      continue;
    }
    // A run: a value for each node from the first on, in its session.
    if (ref.length !== 2)
      throw invalid("its state patch has a run that is not a node and a count");
    let start = ref[0];
    if (typeof start === "number") last = start += last;
    const first = nodeOf(start, prefix, base);
    const firstDot = first.lastIndexOf(".");
    const session = first.slice(0, firstDot + 1);
    const clock = clockAt(first, firstDot);
    const count = ref[1];
    assertRun(first, clock, count);
    if (!isList(value) || value.length !== count)
      throw invalid(
        `a run of ${count} nodes from '${first}' does not have a value for each`,
      );
    for (let i = 0; i < count; i++)
      patchOf(patch, session + numberToBase64(clock + i))[key] = value[i]!;
  }
  return patch;
}

/**
 * The draft that a batch (see the format above) stands for. It throws on a
 * batch that does not follow the format, before anything is applied: each
 * check is a comparison in a loop the decoding already makes.
 */
export function decodeOperations(operations: Operations): DraftOperations {
  const head = operations[0];
  if (typeof head !== "string")
    throw new Error(
      "These operations are in the previous format: convert them with `upgradeOperations` from `@docukit/docnode/compat`.",
    );
  const dot = head.lastIndexOf(".");
  const base = clockAt(head, dot);
  const prefix = head.slice(0, dot + 1);
  const ordered: OrderedOperation[] = [];
  if (isFlat(operations)) {
    readRow(operations, 1, 1, prefix, base, ordered, 0);
    return [ordered, new Map()];
  }
  let patch: StatePatch = new Map();
  let inserted = 0;
  for (let index = 1; index < operations.length; index++) {
    const row = operations[index];
    if (!isRow(row)) throw invalid(`its row ${index} is not an operation`);
    if (row[0] === PATCH && index === operations.length - 1)
      patch = readPatch(row, prefix, base);
    else inserted = readRow(row, 0, index, prefix, base, ordered, inserted);
  }
  return [ordered, patch];
}

/**
 * @internal For tests and `@docukit/docnode-lexical`: what a batch stands
 * for, in order and with whole ids.
 */
export const _INTERNAL_decodeOperations = decodeOperations;
