import type {
  DraftOperations,
  NodeRef,
  Operations,
  OperationsRow,
  OrderedOperation,
  StatePatch,
} from "./operations.js";
import type { Json } from "./types.js";
import { clockAt, numberToBase64 } from "./idGenerator.js";

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
function headOf([ordered, patch]: DraftOperations) {
  for (const op of ordered) {
    const first = op[0] === 0 ? op[1][0]![0] : op[1];
    if (clockOf(first) >= 0) return first;
  }
  for (const id in patch) if (clockOf(id) >= 0) return id;
  return "";
}

/** A draft as it travels (see the format above). */
export function encodeOperations(draft: DraftOperations): Operations {
  const head = headOf(draft);
  const dot = head.lastIndexOf(".");
  const base = clockAt(head, dot);
  const prefix = head.slice(0, dot + 1);
  const ref = (id: string | 0): NodeRef => {
    if (id === 0 || base < 0 || !id.startsWith(prefix)) return id;
    // -1 for a clock with a dot or one that would not be written back the same.
    const clock = clockAt(id, dot);
    if (clock < 0) return id;
    return clock >= base ? clock - base + 1 : clock - base;
  };
  const [ordered, patch] = draft;
  const rows: [string, ...OperationsRow[]] = [head];
  for (const op of ordered) {
    if (op[0] === 0) {
      const list = op[1];
      const nodes: ([NodeRef, string] | [NodeRef, string, number])[] = [];
      for (let at = 0; at < list.length; ) {
        const [id, type] = list[at]!;
        let count = 1;
        while (
          at + count < list.length &&
          list[at + count]![1] === type &&
          follows(list[at + count - 1]![0], list[at + count]![0])
        )
          count++;
        nodes.push(count > 1 ? [ref(id), type, count] : [ref(id), type]);
        at += count;
      }
      rows.push([0, nodes, ref(op[2]), ref(op[3]), ref(op[4])]);
    } else if (op[0] === 1) {
      rows.push([1, ref(op[1]), ref(op[2])]);
    } else {
      const [, start, end, parent, prev, next] = op;
      rows.push([2, ref(start), ref(end), ref(parent), ref(prev), ref(next)]);
    }
  }
  const nodes: NodeRef[] = [];
  const keys: string[] = [];
  const values: Json[] = [];
  let last = 0;
  for (const id in patch) {
    const node = ref(id);
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

/** The draft that a batch (see the format above) stands for. */
export function decodeOperations(operations: Operations): DraftOperations {
  const [head, ...rows] = operations;
  const dot = head.lastIndexOf(".");
  const base = clockAt(head, dot);
  const prefix = head.slice(0, dot + 1);
  const node = (ref: NodeRef): string =>
    typeof ref === "string"
      ? ref
      : prefix + numberToBase64(ref > 0 ? base + ref - 1 : base + ref);
  const id = (ref: NodeRef): string | 0 => (ref === 0 ? 0 : node(ref));
  const ordered: OrderedOperation[] = [];
  const patch: StatePatch = {};
  for (const row of rows) {
    if (row[0] === 0) {
      const nodes: [string, string][] = [];
      for (const [ref, type, count = 1] of row[1]) {
        const first = node(ref);
        nodes.push([first, type]);
        if (count === 1) continue;
        // A run: the nodes after the first, in its session.
        const firstDot = first.lastIndexOf(".");
        const session = first.slice(0, firstDot + 1);
        const clock = clockAt(first, firstDot);
        for (let i = 1; i < count; i++)
          nodes.push([session + numberToBase64(clock + i), type]);
      }
      ordered.push([0, nodes, id(row[2]), id(row[3]), id(row[4])]);
    } else if (row[0] === 1) {
      ordered.push([1, node(row[1]), id(row[2])]);
    } else if (row[0] === 2) {
      const [, start, end, parent, prev, next] = row;
      ordered.push([2, node(start), id(end), id(parent), id(prev), id(next)]);
    } else {
      const [, nodes, keys, values] = row;
      let last = 0;
      for (let entry = 0; entry < nodes.length; entry++) {
        let ref = nodes[entry]!;
        if (typeof ref === "number") last = ref += last;
        (patch[node(ref)] ??= {})[keys[entry]!] = values[entry]!;
      }
    }
  }
  return [ordered, patch];
}

/**
 * @internal For tests and `@docukit/docnode-lexical`: what a batch stands
 * for, in order and with whole ids.
 */
export const _INTERNAL_decodeOperations = decodeOperations;
