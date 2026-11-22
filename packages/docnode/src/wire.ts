import type {
  DraftOperations,
  FlatRow,
  Head,
  NodeRef,
  Operations,
  OperationsRow,
  OrderedOperation,
  StatePatch,
  StatePatchRow,
} from "./operations.js";
import type { Json } from "./types.js";
import { idRecord, parseJson, stringifyJson } from "./utils.js";
import {
  base64ToNumber,
  clockAt,
  lastDot,
  numberToBase64,
} from "./idGenerator.js";

// ----- wire format -----------------------------------------------------------
//
// `Operations` is one batch as it travels and is stored: `[head, ...rows]`,
// read on its own, whatever arrived before.
//
// - `head` names the sessions of the batch: `"session.clock"` or
//   `["session.clock", ...others]`, the clock (in base 64) of the first node
//   of the head's session. Rows name a session by its index there, and leave
//   out the index of the first.
// - `[0, nodes, parent, prev, next]`, `[1, start, end]` and `[2, start, end,
//   parent, prev, next]` insert, delete and move nodes, without their
//   trailing zeros. One node is inserted as `[0, node, type, parent, prev,
//   next]`, without the list, and `[1]` deletes the node at the head's clock
//   (`[1, 1]`), the one a batch that only deletes it names in its head.
// - The state patch, if any, is the last row: `[-9, node, key, value, ...]`,
//   a triple per key a node changed. `[node, count], key, column` sets `key`
//   of `count` nodes one after the other (see `Run`), a value each.
// - A node id `session.clock` is `"index.clock"`; any other id is itself, with a
//   `!` in front if it starts with one or reads as a distance. A node of the
//   head's session can be written by its clock's distance `d` from the head's
//   clock instead, when that is not longer: `d + 1` from 0 on, `d` below (so
//   `1` is the node at the clock and `-1` the one before). It is written as a
//   number, and a string with its sign (`"+1"`, `"-1"`) reads as one too. A
//   batch that inserts a node after the one its author inserted before writes
//   the same rows every time: only the head changes.
// - A batch of one row is written without the row's brackets, and so is a
//   batch of only a state patch.

const isList = (value: Json | undefined): value is readonly Json[] =>
  Array.isArray(value);

const list = (value: Json | undefined): readonly Json[] =>
  isList(value) ? value : [];

const num = (value: Json | undefined) => Number(value);

/** A string of the batch, or "" where it holds something else. */
const text = (value: Json | undefined): string =>
  typeof value === "string" ? value : "";

/** Whether `written` is a signed integer: a node by its distance (see the format). */
const isDistance = (written: string) => /^[+-]\d+$/.test(written);

/** The tag of the state patch row (see the format). */
const PATCH = -9;

/**
 * Reads ids one by one and tells whether each is the node right after the
 * one before (same session, next clock): the session and clock of each id
 * are read once, whatever the length of the run.
 */
class Run {
  private _id = "";
  private _dot = -1;
  private _clock = -1;

  /** Starts a run at `id`. */
  start(id: string): void {
    this._id = id;
    this._dot = lastDot(id);
    this._clock = this._dot === -1 ? -1 : clockAt(id, this._dot);
  }

  /** Whether `next` follows the run's last id: then it is the last one. */
  follows(next: string): boolean {
    const dot = this._dot;
    // A dot of `next` after this one makes its clock unreadable (-1).
    if (this._clock < 0 || next.charCodeAt(dot) !== 46) return false;
    const clock = clockAt(next, dot);
    if (clock !== this._clock + 1) return false;
    const id = this._id;
    for (let i = 0; i < dot; i++)
      if (id.charCodeAt(i) !== next.charCodeAt(i)) return false;
    this._id = next;
    this._clock = clock;
    return true;
  }
}

/** Reused by every batch: encoding is not reentrant. */
const run = new Run();

/** The `count` nodes from `id` on (see `Run`). */
function nodesFrom(id: string, count: number): string[] {
  const dot = lastDot(id);
  const prefix = id.slice(0, dot + 1);
  const clock = clockAt(id, dot);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(prefix + numberToBase64(clock + i));
  return ids;
}

/** The clock a distance from `base` stands for (see the format). */
const clockOf = (distance: number, base: number) =>
  distance > 0 ? base + distance - 1 : base + distance;

/**
 * The distance a node id is written as (see the format), or 0 when it is
 * not one of `session` or its distance from `base` is longer than its clock.
 */
function distanceTo(id: string, session: string, base: number) {
  const dot = session.length;
  // A dot after the session's: the clock is not in base 64.
  if (base < 0 || id.charCodeAt(dot) !== 46 || !id.startsWith(session))
    return 0;
  const clock = clockAt(id, dot);
  if (clock < 0) return 0;
  const distance = clock >= base ? clock - base + 1 : clock - base;
  // With its sign, it takes no more characters than the dot and the clock.
  return Math.abs(distance) < 10 ** (id.length - dot - 1) ? distance : 0;
}

/** An id as it is written whole: with a `!` if it could be misread. */
const literal = (id: string) =>
  id.charCodeAt(0) === 33 || isDistance(id) ? `!${id}` : id;

/** `id` if it is `session.clock`, with a dot. */
const withSession = (id: string | 0) =>
  id !== 0 && lastDot(id) !== -1 ? id : undefined;

/**
 * A tree row without the zeros at the end of its nodes: the first node, and
 * the type of a node inserted alone, are never `0`.
 */
function trimmed<Row extends unknown[]>(row: Row): Row {
  while (row.length > 2 && row[row.length - 1] === 0) row.pop();
  return row;
}

/** Whether a batch of only `row` leaves out its brackets: a tree row. */
const isFlat = (row: OperationsRow | undefined): row is FlatRow =>
  Array.isArray(row);

/** Up to this many other sessions, a batch finds their index without a map. */
const FEW_SESSIONS = 8;

class Encoder {
  /** The first session of the batch, index 0. */
  first = "";
  /** The other sessions, from index 1. */
  others: string[] = [];
  /** The index of each other session, once there are many. */
  private _indexes: Map<string, number> | undefined;
  /** The clock the head carries, which nodes are written from; -1 if none. */
  base = -1;

  /**
   * Starts a batch: its first session is that of its first node id that has
   * one, and its clock that node's (-1 if none, or a clock not written in
   * base 64).
   */
  start(ordered: readonly OrderedOperation[], patch: StatePatch): void {
    let first: string | undefined;
    for (const op of ordered) {
      first = withSession(op[0] === 0 ? op[1][0]![0] : op[1]);
      if (first) break;
    }
    if (first === undefined)
      for (const id in patch) if ((first = withSession(id))) break;
    const named = first ?? "";
    const dot = lastDot(named);
    this.first = dot === -1 ? "" : named.slice(0, dot);
    // Cheaper than emptying them, which reallocates even when empty.
    if (this.others.length > 0) {
      this.others = [];
      this._indexes = undefined;
    }
    this.base = dot === -1 ? -1 : clockAt(named, dot);
  }

  index(session: string): number {
    if (session === this.first) return 0;
    const others = this.others;
    // A batch names few sessions: looking through them beats a map.
    if (others.length < FEW_SESSIONS) {
      for (let index = 0; index < others.length; index++)
        if (others[index] === session) return index + 1;
      return others.push(session);
    }
    this._indexes ??= new Map(others.map((other, index) => [other, index + 1]));
    let index = this._indexes.get(session);
    if (index === undefined) {
      index = others.push(session);
      this._indexes.set(session, index);
    }
    return index;
  }

  private _absolute(id: string): string {
    const dot = lastDot(id);
    if (dot === -1) return literal(id);
    // Cut and compared, a short session is found faster than with
    // `startsWith`.
    const index = this.index(id.slice(0, dot));
    return index === 0 ? id.slice(dot) : `${index}${id.slice(dot)}`;
  }

  /** A node of a tree row: its distance is a number there. */
  nodeRef(id: string | 0): NodeRef {
    if (id === 0) return 0;
    const distance = distanceTo(id, this.first, this.base);
    return distance === 0 ? this._absolute(id) : distance;
  }
}

/** Reused by every batch: encoding is not reentrant. */
const encoder = new Encoder();

/** The batch of a transaction as `Operations`. */
export function encodeOperations(
  ordered: readonly OrderedOperation[],
  patch: StatePatch,
): Operations {
  encoder.start(ordered, patch);
  const base = encoder.base;
  // The head is known at the end: it gets a slot now, not a copy then.
  const rows: [Head, ...OperationsRow[]] = [""];
  for (const op of ordered) {
    if (op[0] === 0) {
      const nodes: (
        | readonly [NodeRef, string]
        | readonly [NodeRef, string, number]
      )[] = [];
      const list = op[1];
      for (let at = 0; at < list.length; ) {
        const [id, type] = list[at]!;
        // Nodes one right after the other, of one type: the first and a count.
        let count = 1;
        run.start(id);
        while (
          at + count < list.length &&
          list[at + count]![1] === type &&
          run.follows(list[at + count]![0])
        )
          count++;
        const ref = encoder.nodeRef(id);
        nodes.push(count > 1 ? [ref, type, count] : [ref, type]);
        at += count;
      }
      const parent = encoder.nodeRef(op[2]);
      const prev = encoder.nodeRef(op[3]);
      const next = encoder.nodeRef(op[4]);
      const only = nodes.length === 1 ? nodes[0]! : undefined;
      if (only?.length === 2) {
        // One node, without the list (see the format).
        const row: [0, NodeRef, string, ...NodeRef[]] = [
          0,
          only[0],
          only[1],
          parent,
          prev,
          next,
        ];
        rows.push(trimmed(row));
      } else {
        const row: [0, typeof nodes, ...NodeRef[]] = [
          0,
          nodes,
          parent,
          prev,
          next,
        ];
        rows.push(trimmed(row));
      }
    } else if (op[0] === 1) {
      const start = encoder.nodeRef(op[1]);
      const end = encoder.nodeRef(op[2]);
      // The node at the head's clock alone is left out (see the format).
      const row: [1, ...NodeRef[]] = [1, start, end];
      rows.push(start === 1 && end === 0 ? [1] : trimmed(row));
    } else {
      const row: [2, NodeRef, ...NodeRef[]] = [
        2,
        encoder.nodeRef(op[1]),
        encoder.nodeRef(op[2]),
        encoder.nodeRef(op[3]),
        encoder.nodeRef(op[4]),
        encoder.nodeRef(op[5]),
      ];
      rows.push(trimmed(row));
    }
  }
  // Read once: a patch has a key per node id, each one new to the engine.
  const ids: string[] = [];
  const states: Record<string, string>[] = [];
  for (const id in patch) {
    ids.push(id);
    states.push(patch[id]!);
  }
  if (ids.length > 0) rows.push(patchRow(ids, states));
  const { first, others } = encoder;
  const named =
    base !== -1 || first.includes(".")
      ? `${first}.${numberToBase64(Math.max(base, 0))}`
      : first;
  const head = others.length === 0 ? named : [named, ...others];
  const row = rows[1];
  if (rows.length === 2 && isFlat(row)) return [head, ...row];
  rows[0] = head;
  return rows;
}

/**
 * The state patch row: `[PATCH, node, key, value, ...]`, and for nodes one
 * after the other with the same keys (see `runLength`), `[node, count], key,
 * column` per key (see the format).
 */
function patchRow(
  ids: readonly string[],
  states: readonly Record<string, string>[],
): StatePatchRow {
  const row: [typeof PATCH, ...Json[]] = [PATCH];
  for (let at = 0; at < ids.length; ) {
    const written = states[at]!;
    const length = runLength(ids, states, at);
    const node = encoder.nodeRef(ids[at]!);
    if (length < 3) {
      for (const key in written) row.push(node, key, parseJson(written[key]!));
      at++;
      continue;
    }
    // A column per key, a value per node from the first one on.
    const nodes = [node, length];
    for (const key in written) {
      const column: Json[] = [];
      for (let i = at; i < at + length; i++)
        column.push(parseJson(states[i]![key]!));
      row.push(nodes, key, column);
    }
    at += length;
  }
  return row;
}

/**
 * How many patch entries from `at` on are nodes one right after the other
 * (see `Run`) with the same keys.
 */
function runLength(
  ids: readonly string[],
  states: readonly Record<string, string>[],
  at: number,
) {
  const keys = Object.keys(states[at]!);
  let length = 1;
  run.start(ids[at]!);
  while (
    at + length < ids.length &&
    run.follows(ids[at + length]!) &&
    hasKeys(states[at + length]!, keys)
  )
    length++;
  return length;
}

/** Whether `state` has `keys`, in that order, and no other. */
function hasKeys(state: Record<string, string>, keys: readonly string[]) {
  let index = 0;
  for (const key in state) if (keys[index++] !== key) return false;
  return index === keys.length;
}

/** The number written before the dot of `"index.counter"`, `""` being 0. */
function indexBefore(written: string, dot: number): number {
  let index = 0;
  for (let i = 0; i < dot; i++) index = index * 10 + written.charCodeAt(i) - 48;
  return index;
}

const NO_SESSIONS: readonly string[] = [];

class Decoder {
  /** The head's sessions, the first one as `_first` (without its clock). */
  private _sessions = NO_SESSIONS;
  private _first = "";
  /** The head's clock: nodes written by their distance are from it. */
  private _base = 0;

  /** Starts a batch with its head. */
  reset(head: string | readonly string[]): void {
    const named = typeof head === "string" ? head : head[0]!;
    this._sessions = typeof head === "string" ? NO_SESSIONS : head;
    const dot = lastDot(named);
    this._first = dot === -1 ? named : named.slice(0, dot);
    this._base = dot === -1 ? 0 : base64ToNumber(named, dot + 1);
  }

  private _sessionAt(index: number): string {
    return index === 0 ? this._first : this._sessions[index]!;
  }

  /**
   * A node id: `"index.clock"` is `session.clock` inside, the clock in base
   * 64 as here, so only the session is looked up.
   */
  node(written: string): string {
    if (written.charCodeAt(0) === 33) return written.slice(1);
    const dot = written.indexOf(".");
    if (dot === -1)
      return isDistance(written) ? this._at(Number(written)) : written;
    return this._sessionAt(indexBefore(written, dot)) + written.slice(dot);
  }

  /** The node of the first session at `distance` from the head's clock. */
  private _at(distance: number): string {
    return `${this._first}.${numberToBase64(clockOf(distance, this._base))}`;
  }

  /** A node of a tree row: a number is its distance. */
  nodeRef(value: Json | undefined): string | 0 {
    if (typeof value === "number") return value === 0 ? 0 : this._at(value);
    return value ? this.node(text(value)) : 0;
  }

  /** A node a tree row must name: `""` where a broken row has none. */
  nodeId(value: Json | undefined): string {
    return this.nodeRef(value) || "";
  }

  /** The tree row that starts at `row[at]`, added to `ordered`. */
  row(row: readonly Json[], at: number, ordered: OrderedOperation[]): void {
    const tag = row[at];
    const N = (offset: number) => this.nodeRef(row[at + offset]);
    if (tag === 0) {
      const nodes: [string, string][] = [];
      const first = row[at + 1];
      // One node, without the list.
      if (!isList(first)) {
        nodes.push([this.nodeId(first), text(row[at + 2])]);
        ordered.push([0, nodes, N(3), N(4), N(5)]);
        return;
      }
      for (const node of first) {
        if (!isList(node)) continue;
        // `[distance, type, count]`: a run of nodes one after the other.
        if (node.length < 3) {
          nodes.push([this.nodeId(node[0]), text(node[1])]);
          continue;
        }
        const type = text(node[1]);
        for (const id of nodesFrom(this.nodeId(node[0]), num(node[2])))
          nodes.push([id, type]);
      }
      ordered.push([0, nodes, N(2), N(3), N(4)]);
    } else if (tag === 1) {
      // `[1]`: the node at the head's clock.
      const start = at + 1 < row.length ? row[at + 1] : 1;
      ordered.push([1, this.nodeId(start), N(2)]);
    } else if (tag === 2) {
      ordered.push([2, this.nodeId(row[at + 1]), N(2), N(3), N(4), N(5)]);
    }
  }
}

/** Reused by every batch: decoding is not reentrant. */
const decoder = new Decoder();

/**
 * The patch of a batch without one, shared: a decoded batch is only read, and
 * a frozen object makes sure of it.
 */
const NO_PATCH: StatePatch = Object.freeze({});

/** The state patch of a `patchRow` whose triples start at `row[from]`. */
function readPatch(row: readonly Json[], from: number): StatePatch {
  let patch: StatePatch | undefined;
  for (let at = from; at < row.length; at += 3) {
    const written = row[at];
    const key = text(row[at + 1]);
    const value = row[at + 2];
    if (!isList(written)) {
      const id = decoder.nodeId(written);
      // Keyed by nodes of a session, new ids each time, it is a dictionary;
      // by an id like the root's, a plain object (see `idRecord`).
      patch ??= lastDot(id) === -1 ? {} : idRecord();
      (patch[id] ??= {})[key] = stringifyJson(value);
      continue;
    }
    // A run: a column of values, one per node from the first one on.
    const ids = nodesFrom(decoder.nodeId(written[0]), num(written[1]));
    const column = list(value);
    patch ??= idRecord();
    for (let i = 0; i < ids.length; i++)
      (patch[ids[i]!] ??= {})[key] = stringifyJson(column[i]);
  }
  return patch ?? {};
}

/** The ordered operations and state patch that `Operations` stands for. */
export function decodeOperations(operations: Operations): DraftOperations {
  decoder.reset(operations[0]);
  const ordered: OrderedOperation[] = [];
  const only = operations[1];
  if (only === PATCH) return [ordered, readPatch(operations, 2)];
  if (typeof only === "number") {
    decoder.row(operations, 1, ordered);
    return [ordered, NO_PATCH];
  }
  let patch = NO_PATCH;
  for (let index = 1; index < operations.length; index++) {
    const row = operations[index];
    if (!isList(row)) continue;
    // The patch is the batch's last row.
    if (row[0] === PATCH) patch = readPatch(row, 1);
    else decoder.row(row, 0, ordered);
  }
  return [ordered, patch];
}

/**
 * @internal - For tests only. What a batch stands for, in order and with whole
 * ids: tests check it against the diff.
 */
export const _INTERNAL_decodeOperations = decodeOperations;
