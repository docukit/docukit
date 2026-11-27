import type {
  DraftOperations,
  NodeRef,
  Operations,
  OperationsRow,
  OrderedOperation,
  OrderedRow,
  PatchRow,
  StatePatch,
  TextOperation,
} from "./operations.js";
import type { Json } from "./types.js";
import { MAX_CLOCK, clockAt, numberToBase64 } from "./idGenerator.js";
import { patchOf } from "./operations.js";
import { ownId, ownKey } from "./utils.js";

// `Operations`, a batch as it travels and is stored, is `[head, ...rows]`,
// plain JSON read on its own:
//
// - `head` is the id of the first node of the form `session.clock` (see
//   `clockAt`) that the batch names, or "" if none. A node of its session is written as a number:
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
// - The state patch, if any, is the last row: `[3, node, key, value, ...]`,
//   a triple per key a node changed, the value as JSON. `[node, count], key,
//   values` sets `key` on `count` nodes one right after the other, a value
//   each, so an insert of many nodes writes each key once. A number node,
//   alone or first of a run, is its difference from the number node before
//   it in the row (from 0), as Automerge's delta columns and lib0's
//   `IntDiffOptRleEncoder` write ids.
// - A batch of one row that is not a state patch is written without the
//   row's brackets: `[head, 1, 1]` deletes the head's node.
// - An insert of letters (`TextOperation`, see `text.ts`) is a string row:
//   `"prev,next|text"`, the letters after the first `|` as they are. `prev`
//   and `next` are letters as the nodes above (a number, or a whole id, which
//   has a `.`), `prev` empty for the start of the text and `next` `0` for its
//   end. `"prev|text"` leaves out a `next` that is the letter made right
//   after `prev`. `"@node,key|text"` inserts into the empty text of `key` of
//   `node` (`0` for the root). Deleting letters is `[1, first, last]`.
//   When the batch inserts letters, the head is the first of them. The
//   letters of a row take consecutive clocks, from the one after the last
//   letter of the row before (the head for the first row); a row whose
//   letters start elsewhere says where first: `"N>prev,next|text"`.
// - Letters put back by an undo come from runs of many sessions. Runs that go
//   one after the other, each between the run before and the same `next`,
//   are one row: `"N:4,M:2,K>prev,next|text"` says where each run starts
//   and how many letters it has (the last one has the rest). A start left
//   out is the letter after the run before, as for a row. The later runs of
//   `"…>@node,key|text"` go to the end of that text.
// - Moving letters is `[2, first, last, 0, prev, next]`, like moving nodes
//   with the letters as above (`parent` `0`): the letters keep their ids, so
//   the row does not write them. `[2, first, last, node, 0, 0, key]` moves
//   them into the empty text of `key` of `node` (`0` for the root).

/** The tag of the state patch row. */
const PATCH = 3;

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

/**
 * The first new letter of a draft, or else the first node id of the form
 * `session.clock` that it names.
 */
function headOf(draft: DraftOperations) {
  for (const op of draft[0]) if (op[0] === 4) return op[1];
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

/** The id of the letter `count` letters after the letter `id`. */
function letterAfter(id: string, count: number) {
  const dot = id.lastIndexOf(".");
  return id.slice(0, dot + 1) + numberToBase64(clockAt(id, dot) + count);
}

/** Whether an ordered operation inserts letters. */
const isLetters = (op: OrderedOperation | undefined): op is TextOperation =>
  op?.[0] === 4;

/**
 * Whether `op` puts letters right after those of `before`, between them and
 * the same letter as `first`, the first insert of a row (or at the end of
 * the text that `first` inserts into): it goes in the row of `first`.
 */
function continues(
  first: TextOperation,
  before: TextOperation,
  op: OrderedOperation | undefined,
): op is TextOperation {
  return (
    isLetters(op) &&
    op[6] === undefined &&
    op[3] === (first[6] === undefined ? first[3] : 0) &&
    op[2] === letterAfter(before[1], before[4].length - 1)
  );
}

/** Where letters that start at `first` start, in a row that expects `expected`. */
const startOf = (
  first: string,
  expected: string,
  prefix: string,
  dot: number,
  base: number,
) => (first === expected ? "" : String(refOf(first, prefix, dot, base)));

/**
 * The row of the inserts of letters whose first one is `op` (see the format
 * above): `starts` says where their letters start, if not where expected,
 * and `text` has their letters.
 *
 * PENDING (open question of the text design): where the letters of a row
 * start. This is option B, a `N>` only when they do not start right after
 * the letters of the row before; options A (an order rule, no `N>`) and C
 * (always `N>`) would change only `encodeOperations` and `readLetters`.
 */
function letterRowOf(
  op: TextOperation,
  starts: string,
  text: string,
  prefix: string,
  dot: number,
  base: number,
) {
  const [, , prev, next, , node, key] = op;
  let row = starts === "" ? "" : `${starts}>`;
  if (key !== undefined)
    row += `@${node === 0 ? 0 : refOf(node!, prefix, dot, base)},${key}`;
  else {
    if (prev !== 0) row += refOf(prev, prefix, dot, base);
    if (prev === 0 || next === 0 || !follows(prev, next))
      row += `,${next === 0 ? 0 : refOf(next, prefix, dot, base)}`;
  }
  return `${row}|${text}`;
}

/** An ordered operation as a row of a batch (see the format above). */
function rowOf(
  op: Exclude<OrderedOperation, TextOperation>,
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
    // Letters into an empty text: its key, after the zeros.
    if (op[6] !== undefined)
      return [
        2,
        refOf(op[1], prefix, dot, base),
        refOf(op[2], prefix, dot, base),
        refOf(op[3], prefix, dot, base),
        0,
        0,
        op[6],
      ];
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
  const only = ordered.length === 1 && !patch ? ordered[0]! : undefined;
  // One row without its brackets (see the format).
  if (only && only[0] !== 4) return [head, ...rowOf(only, prefix, dot, base)];
  const rows: [string, ...OperationsRow[]] = [head];
  // Where the letters of the next insert of letters start, if not elsewhere.
  let expected = head;
  for (let i = 0; i < ordered.length; i++) {
    const op = ordered[i]!;
    if (!isLetters(op)) {
      rows.push(rowOf(op, prefix, dot, base));
      continue;
    }
    // The inserts after it that go in its row (see the format above).
    let starts = startOf(op[1], expected, prefix, dot, base);
    let text = op[4];
    let last = op;
    let run = ordered[i + 1];
    while (continues(op, last, run)) {
      const after = letterAfter(last[1], last[4].length);
      starts += `:${last[4].length},${startOf(run[1], after, prefix, dot, base)}`;
      text += run[4];
      last = run;
      run = ordered[++i + 1];
    }
    rows.push(letterRowOf(op, starts, text, prefix, dot, base));
    expected = letterAfter(last[1], last[4].length);
  }
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

/**
 * The whole id of a node or letter of a string row: a whole id has a `.`,
 * anything else is a number (see `nodeOf`).
 */
function refIn(ref: string, prefix: string, base: number, index: number) {
  if (ref.includes(".")) return ownId(ref);
  if (!/^-?\d+$/.test(ref))
    throw invalid(`its row ${index} names '${ref}', which is not a node`);
  return nodeOf(Number(ref), prefix, base);
}

/**
 * Adds to `ordered` the inserts of letters of the string row `row` (the
 * `index`th of the batch), whose letters start at `expected` unless it says
 * where (see `letterRowOf`). Returns where the letters of the next one start.
 */
function readLetters(
  row: string,
  index: number,
  prefix: string,
  base: number,
  expected: string,
  ordered: OrderedOperation[],
) {
  const bar = row.indexOf("|");
  if (bar < 0) throw invalid(`its row ${index} is not an operation`);
  const text = row.slice(bar + 1);
  let anchors = row.slice(0, bar);
  const start = anchors.indexOf(">");
  // Where each run starts, with the length of each but the last.
  const starts = start < 0 ? [""] : anchors.slice(0, start).split(",");
  anchors = anchors.slice(start + 1);
  let prev: string | 0 = 0;
  let next: string | 0 = 0;
  let node: string | 0 = 0;
  let key: string | undefined;
  const comma = anchors.indexOf(",");
  if (anchors.startsWith("@")) {
    if (comma < 0) throw invalid(`its row ${index} does not name a key`);
    const ref = anchors.slice(1, comma);
    if (ref !== "0") node = refIn(ref, prefix, base, index);
    key = ownKey(anchors.slice(comma + 1));
  } else if (comma < 0) {
    // `next` left out: the letter made right after `prev`.
    prev = refIn(anchors, prefix, base, index);
    const prevClock = clockOf(prev);
    if (prevClock < 0 || prevClock >= MAX_CLOCK)
      throw invalid(`its row ${index} has no letter after '${prev}'`);
    next = letterAfter(prev, 1);
  } else {
    const before = anchors.slice(0, comma);
    const after = anchors.slice(comma + 1);
    if (before !== "") prev = refIn(before, prefix, base, index);
    if (after !== "0") next = refIn(after, prefix, base, index);
  }
  let at = 0;
  for (let i = 0; i < starts.length; i++) {
    let ref = starts[i]!;
    let length = text.length - at;
    if (i < starts.length - 1) {
      const colon = ref.indexOf(":");
      const count = ref.slice(colon + 1);
      if (colon < 0 || !/^\d+$/.test(count) || Number(count) >= length)
        throw invalid(`its row ${index} has a run without its length`);
      length = Number(count);
      ref = ref.slice(0, colon);
    }
    const first = ref === "" ? expected : refIn(ref, prefix, base, index);
    const clock = clockOf(first);
    if (length < 1 || clock < 0 || clock + length - 1 > MAX_CLOCK)
      throw invalid(`its row ${index} does not insert letters of a session`);
    const letters = text.slice(at, at + length);
    if (i > 0)
      ordered.push([4, first, prev, key === undefined ? next : 0, letters]);
    else if (key === undefined) ordered.push([4, first, prev, next, letters]);
    else ordered.push([4, first, 0, 0, letters, node, key]);
    // The next run goes right after this one.
    prev = letterAfter(first, length - 1);
    expected = letterAfter(first, length);
    at += length;
  }
  return expected;
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
    const key = row[at + 6];
    if (typeof key === "string") {
      // Letters into an empty text (see the format above).
      if (row[at + 4] !== 0 || row[at + 5] !== 0)
        throw invalid(`its row ${index} is not an operation`);
      ordered.push([
        2,
        nodeOf(row[at + 1], prefix, base),
        idOf(row[at + 2], prefix, base),
        idOf(row[at + 3], prefix, base),
        0,
        0,
        ownKey(key),
      ]);
      end = at + 6;
    } else {
      ordered.push([
        2,
        nodeOf(row[at + 1], prefix, base),
        idOf(row[at + 2], prefix, base),
        idOf(row[at + 3], prefix, base),
        idOf(row[at + 4], prefix, base),
        idOf(row[at + 5], prefix, base),
      ]);
      end = at + 5;
    }
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
  let expected = head;
  for (let index = 1; index < operations.length; index++) {
    const row = operations[index];
    if (typeof row === "string") {
      expected = readLetters(row, index, prefix, base, expected, ordered);
      continue;
    }
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
