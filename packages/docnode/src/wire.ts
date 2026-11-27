import type {
  DraftOperations,
  NodeRef,
  Operations,
  OperationsRow,
  OrderedOperation,
  StatePatch,
} from "./operations.js";
import type { Json } from "./types.js";
import { MAX_CLOCK, clockAt, numberToBase64 } from "./idGenerator.js";
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
//   parent, prev, next]` insert, delete and move nodes, as `OrderedOperation`.
//   `nodes` has `[node, type]` for each node, or `[node, type, count]` for
//   `count` nodes of a type, each made right after the one before (like a
//   run of Yjs structs, or of ids in a stored document).
// - The state patch, if any, is the last row: `[-9, nodes, keys, values]`,
//   columns with an entry per key a node changed, the value as JSON, like the
//   columns of Automerge and Loro, and of a stored document. A number in
//   `nodes` is its difference from the number before it there (from 0), as
//   Automerge's delta columns and lib0's `IntDiffOptRleEncoder` write ids:
//   the nodes of an insert of many come one after the other, `1` each.

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
  for (const id in draft[1]) if (clockOf(id) >= 0) return id;
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

/** A draft as it travels (see the format above). */
export function encodeOperations(draft: DraftOperations): Operations {
  const head = headOf(draft);
  const dot = head.lastIndexOf(".");
  const base = clockAt(head, dot);
  const prefix = head.slice(0, dot + 1);
  const patch = draft[1];
  const rows: [string, ...OperationsRow[]] = [head];
  for (const op of draft[0]) {
    if (op[0] === 0) {
      const list = op[1];
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
      rows.push([
        0,
        nodes,
        refOf(op[2], prefix, dot, base),
        refOf(op[3], prefix, dot, base),
        refOf(op[4], prefix, dot, base),
      ]);
    } else if (op[0] === 1) {
      rows.push([
        1,
        refOf(op[1], prefix, dot, base),
        refOf(op[2], prefix, dot, base),
      ]);
    } else {
      rows.push([
        2,
        refOf(op[1], prefix, dot, base),
        refOf(op[2], prefix, dot, base),
        refOf(op[3], prefix, dot, base),
        refOf(op[4], prefix, dot, base),
        refOf(op[5], prefix, dot, base),
      ]);
    }
  }
  const nodes: NodeRef[] = [];
  const keys: string[] = [];
  const values: Json[] = [];
  let last = 0;
  for (const id in patch) {
    const node = refOf(id, prefix, dot, base);
    const state = patch[id]!;
    for (const key in state) {
      // A number as its difference from the one before (see the format).
      nodes.push(typeof node === "number" ? node - last : node);
      if (typeof node === "number") last = node;
      keys.push(key);
      values.push(state[key]!);
    }
  }
  if (nodes.length > 0) rows.push([PATCH, nodes, keys, values]);
  return rows;
}

/** The most nodes a batch may insert, so that a broken one cannot hang. */
const MAX_BATCH_NODES = 1_000_000;

/** Whether a column of a batch is a list (as a boolean, so that it keeps its type). */
const isList = (column: unknown): boolean => Array.isArray(column);

/** A batch that does not follow the format above. */
const invalid = (why: string) => new Error(`Invalid operations: ${why}.`);

/** The whole id of `ref`, in a batch with a head of `prefix` and `base`. */
function nodeOf(ref: NodeRef, prefix: string, base: number): string {
  if (typeof ref === "string") return ownId(ref);
  const clock = ref > 0 ? base + ref - 1 : base + ref;
  if (
    base < 0 ||
    ref === 0 ||
    !Number.isInteger(ref) ||
    clock < 0 ||
    clock > MAX_CLOCK
  )
    throw invalid(`${ref} is not a node of the head's session`);
  return prefix + numberToBase64(clock);
}

/** Like `nodeOf`, but `0` (none) stays `0`. */
function idOf(ref: NodeRef, prefix: string, base: number): string | 0 {
  return ref === 0 ? 0 : nodeOf(ref, prefix, base);
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
  const patch: StatePatch = {};
  let inserted = 0;
  for (let index = 1; index < operations.length; index++) {
    const row = operations[index] as OperationsRow;
    if (row[0] === 0) {
      const nodes: [string, string][] = [];
      for (const entry of row[1]) {
        const type = entry[1];
        const count = entry[2] ?? 1;
        const first = nodeOf(entry[0], prefix, base);
        nodes.push([first, type]);
        inserted += count;
        if (entry.length === 2) continue;
        // A run: the nodes after the first, in its session.
        const firstDot = first.lastIndexOf(".");
        const session = first.slice(0, firstDot + 1);
        const clock = clockAt(first, firstDot);
        if (!Number.isInteger(count) || count < 2 || clock < 0)
          throw invalid(`a run of ${count} nodes from '${first}'`);
        if (inserted > MAX_BATCH_NODES || clock + count - 1 > MAX_CLOCK)
          throw invalid(`it inserts more than ${MAX_BATCH_NODES} nodes`);
        for (let i = 1; i < count; i++)
          nodes.push([session + numberToBase64(clock + i), type]);
      }
      ordered.push([
        0,
        nodes,
        idOf(row[2], prefix, base),
        idOf(row[3], prefix, base),
        idOf(row[4], prefix, base),
      ]);
    } else if (row[0] === 1) {
      ordered.push([
        1,
        nodeOf(row[1], prefix, base),
        idOf(row[2], prefix, base),
      ]);
    } else if (row[0] === 2) {
      ordered.push([
        2,
        nodeOf(row[1], prefix, base),
        idOf(row[2], prefix, base),
        idOf(row[3], prefix, base),
        idOf(row[4], prefix, base),
        idOf(row[5], prefix, base),
      ]);
    } else if (row[0] === PATCH && index === operations.length - 1) {
      const nodes = row[1];
      const keys = row[2];
      const values = row[3];
      if (
        !isList(nodes) ||
        !isList(keys) ||
        !isList(values) ||
        keys.length !== nodes.length ||
        values.length !== nodes.length
      )
        throw invalid("its state patch is not three lists of equal length");
      let last = 0;
      for (let entry = 0; entry < nodes.length; entry++) {
        let ref = nodes[entry]!;
        if (typeof ref === "number") last = ref += last;
        (patch[nodeOf(ref, prefix, base)] ??= {})[ownKey(keys[entry]!)] =
          values[entry]!;
      }
    } else throw invalid(`its row ${index} is not an operation`);
  }
  return [ordered, patch];
}

/**
 * @internal For tests and `@docukit/docnode-lexical`: what a batch stands
 * for, in order and with whole ids.
 */
export const _INTERNAL_decodeOperations = decodeOperations;
