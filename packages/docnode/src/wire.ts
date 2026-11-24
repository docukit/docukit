import type {
  DraftOperations,
  EditOperation,
  FlatRow,
  Head,
  LetterRef,
  NodeRef,
  Operations,
  OperationsRow,
  OrderedOperation,
  StatePatch,
  StatePatchRow,
} from "./operations.js";
import type { Json } from "./types.js";
import { idRecord, isObjectEmpty, parseJson, stringifyJson } from "./utils.js";
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
// - `head` names the sessions of the batch: `"session.counter"` or
//   `["session.counter", ...others]`. The counter (in base 64) is that of its
//   first text row, or without text rows the clock of the first node of the
//   head's session. Rows name a session by its index there, and leave out the
//   index of the first.
// - A text row has no session nor counter: it takes the session of the row
//   before and the counter right after it. A string `"index.counter"` alone
//   moves on to another one.
//   - `[text, right?, parent?]` inserts letters, `[[text, ...state],
//     right?, parent?]` letters with a first state, and `[-tag, ...]` is any
//     other edit: `-1` deletes letters (`[-1, ranges, lamport?,
//     text?]`, bringing them back with their `text`), `-2` sets their state.
//     Inserts one after the other share a row, `[text, ...refs, text,
//     ...refs]`, when their letters have no state and their references are
//     numbers: a string that does not read as a letter (see `LETTER`) starts
//     the next one. Base's text (see `text/baseText.ts`) names an insert's
//     left letter where the CRDT mode names its parent (`-1`: none), and has
//     three more: `[text, ids, states?, right?, left?]` inserts letters again
//     with the ids a delete took (an undo of it, `-1`: the id next to them),
//     `[5, key, ranges, value?, ...]` sets their state, and `[5, inherited,
//     ranges, value, right?]` sets a key letters inherit, with the letter
//     that was after the ranges (left out: the id after them), the key `n` (a
//     number) as `-(n + 1)` and any other as `[key]`. Only an insert of new
//     letters takes counters.
//   - A letter of the row's own session is a number: the distance back from
//     the row's counter (in a delete, of any sign), but for the right origin
//     of an insert, its counter + 1, negative when the insert is its left
//     child, or `"<"` when the insert is the left child of the letter just
//     before it. `"'"` is the last letter written again. A letter of another
//     session is `"index.counter"`, and `"^node"` is the start of a node's
//     text.
// - `[0, nodes, parent, prev, next]`, `[1, start, end]` and `[2, start, end,
//   parent, prev, next]` insert, delete and move nodes, without their
//   trailing zeros. One node is inserted as `[0, node, type, parent, prev,
//   next]`, without the list, and `[1]` deletes the node at the head's clock
//   (`[1, 1]`), the one a batch that only deletes it names in its head. A
//   row that starts with 0, 1 or 2 is one of these; another text edit starts
//   with 5 or a negative number, an insert with a string or with `[node]`.
// - The state patch, if any, is the last row: `[-9, node, key, value, ...]`,
//   a triple per key a node changed. `[node, count], key, column` sets `key`
//   of `count` nodes one after the other (see `Run`), a value each.
// - A node id `session.clock` is `"index.clock"`; any other id is itself, with a
//   `!` in front if it starts with one or reads as a distance. A node of the
//   head's session can be written by its clock's distance `d` from the head's
//   counter instead, when that is not longer (the core does it in batches
//   without text rows): `d + 1` from 0 on, `d` below (so `1` is the node at
//   the counter and `-1` the one before), a number; a string with its sign
//   (`"+1"`, `"-1"`) reads as one too. A batch that inserts a node after the
//   one its author inserted before writes the same rows every time: only the
//   head changes.
// - A batch of one row is written without the row's brackets, unless the
//   row starts with an array (an insert with a first state).

export const isList = (value: Json | undefined): value is readonly Json[] =>
  Array.isArray(value);

export const list = (value: Json | undefined): readonly Json[] =>
  isList(value) ? value : [];

export const num = (value: Json | undefined) => Number(value);

/** A string of the batch, or "" where it holds something else. */
export const text = (value: Json | undefined): string =>
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
  #id = "";
  #dot = -1;
  #clock = -1;

  /** Starts a run at `id`. */
  start(id: string): void {
    this.#id = id;
    this.#dot = lastDot(id);
    this.#clock = this.#dot === -1 ? -1 : clockAt(id, this.#dot);
  }

  /** Whether `next` follows the run's last id: then it is the last one. */
  follows(next: string): boolean {
    const dot = this.#dot;
    // A dot of `next` after this one makes its clock unreadable (-1).
    if (this.#clock < 0 || next.charCodeAt(dot) !== 46) return false;
    const clock = clockAt(next, dot);
    if (clock !== this.#clock + 1) return false;
    const id = this.#id;
    for (let i = 0; i < dot; i++)
      if (id.charCodeAt(i) !== next.charCodeAt(i)) return false;
    this.#id = next;
    this.#clock = clock;
    return true;
  }
}

/** Reused by every batch: encoding is not reentrant. */
const run = new Run();

/**
 * A tree row without the zeros at the end of its nodes: the first node, and
 * the type of a node inserted alone, are never `0`.
 */
function trimmed<Row extends unknown[]>(row: Row): Row {
  while (row.length > 2 && row[row.length - 1] === 0) row.pop();
  return row;
}

/** The clock a distance from `base` stands for (see the format). */
export const clockOf = (distance: number, base: number) =>
  distance > 0 ? base + distance - 1 : base + distance;

/**
 * The distance a node id is written as (see the format), or 0 when it is
 * not one of `session` or its distance from `base` is longer than its clock.
 */
export function distanceTo(id: string, session: string, base: number) {
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
export const literal = (id: string) =>
  id.charCodeAt(0) === 33 || isDistance(id) ? `!${id}` : id;

/** `id` if it is `session.clock`, with a dot. */
const withSession = (id: string | 0) =>
  id !== 0 && lastDot(id) !== -1 ? id : undefined;

/**
 * The session before the dot at `dot` of a head, as `JSON.parse` returns a
 * short string of a batch: internalized. The text store compares sessions
 * many times to order concurrent letters, and two internalized strings
 * compare by identity. Batches come from a few sessions in turn: the last
 * ones are kept.
 */
function sessionOf(named: string, dot: number): string {
  // Cut and compared, a short session is found faster than with `startsWith`.
  const cut = named.slice(0, dot);
  for (const session of recentSessions) if (cut === session) return session;
  const session = String(JSON.parse(JSON.stringify(cut)));
  recentSessions[nextRecent] = session;
  nextRecent = (nextRecent + 1) % recentSessions.length;
  return session;
}

/** Whether a batch of only `row` leaves out its brackets: not `[[text, ...state]]`. */
const isFlat = (
  row: OperationsRow | undefined,
): row is FlatRow | readonly [string, ...LetterRef[]] =>
  Array.isArray(row) && typeof row[0] !== "object";

/** Up to this many other sessions, a batch finds their index without a map. */
const FEW_SESSIONS = 8;

/** Writes a batch: its head, tree rows and state patch (see `TextEncoder`). */
export class Encoder {
  /** The first session of the batch, index 0. */
  first = "";
  /** The other sessions, from index 1. */
  others: string[] = [];
  /** The index of each other session, once there are many. */
  #indexes: Map<string, number> | undefined;
  /** The counter of the first text row, which the head carries. */
  counter = -1;
  /** The counter the head carries; -1 if none. */
  base = -1;
  /**
   * The counter nodes are written from, -1 for none: with text rows the
   * head's counter is a letter's, far from the clocks of nodes.
   */
  #from = -1;
  // The state of text rows (see `text/wire.ts`).
  protected _session = 0;
  protected _next = 0;
  /** The last letter written as a counter or distance, which `"'"` repeats. */
  protected _lastSession = -1;
  protected _lastCounter = 0;
  /** `"session."` of the last batch of one edit: a session types many. */
  protected _prefixed = "";
  protected _prefix = ".";
  protected _lastNamedSession = "";
  protected _lastNamedCounter = -1;
  protected _lastNamed = "";
  /** The last row, if it is an insert that a next one can join. */
  protected _joinable: Json[] | undefined;

  /** Text rows: only the encoder of `text/wire.ts` writes them. */
  single?(op: EditOperation): Operations;
  edit?(op: EditOperation, rows: (Head | OperationsRow)[]): void;

  /**
   * Starts a batch: its first session and counter are those of its first
   * text row, else the session of its first node id that has one and that
   * node's clock (-1 if none, or a clock not written in base 64).
   */
  start(ordered: readonly OrderedOperation[], patch: StatePatch): void {
    let first: string | undefined;
    for (const op of ordered) {
      if (op[0] === 3) {
        const insert = typeof op[1] === "string";
        this.reset(text(insert ? op[1] : op[2]));
        this.base = Number(insert ? op[2] : op[3]);
        return;
      }
      first ??= withSession(op[0] === 0 ? op[1][0]![0] : op[1]);
    }
    if (first === undefined)
      for (const id in patch) if ((first = withSession(id))) break;
    const named = first ?? "";
    const dot = lastDot(named);
    this.reset(dot === -1 ? "" : named.slice(0, dot));
    this.base = this.#from = dot === -1 ? -1 : clockAt(named, dot);
  }

  id(index: number, counter: number): string {
    return `${index || ""}.${numberToBase64(counter)}`;
  }

  /**
   * `session.counter` (or a node id `session.clock`) as `index.counter`: the
   * counter is already in base 64, so it is copied.
   */
  protected _absolute(id: string): string {
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
    const distance = distanceTo(id, this.first, this.#from);
    return distance === 0 ? this._absolute(id) : distance;
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
    this.#indexes ??= new Map(others.map((other, index) => [other, index + 1]));
    let index = this.#indexes.get(session);
    if (index === undefined) {
      index = others.push(session);
      this.#indexes.set(session, index);
    }
    return index;
  }

  /** `named` is `"session.counter"`: the head of a batch just read or written. */
  remember(session: string, c: number, named: string): void {
    this._lastNamedSession = session;
    this._lastNamedCounter = c;
    this._lastNamed = named;
  }

  /** Starts a batch whose first session is `session`. */
  reset(session: string): void {
    this.first = session;
    // Cheaper than emptying them, which reallocates even when empty.
    if (this.others.length > 0) {
      this.others = [];
      this.#indexes = undefined;
    }
    this.counter = -1;
    this.base = -1;
    this.#from = -1;
    this._session = 0;
    this._next = 0;
    this._lastSession = -1;
    this._lastCounter = 0;
    this._joinable = undefined;
  }
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

/** The number written before the dot of `"index.counter"`, `""` being 0. */
function indexBefore(written: string, dot: number): number {
  let index = 0;
  for (let i = 0; i < dot; i++) index = index * 10 + written.charCodeAt(i) - 48;
  return index;
}

/** The `count` nodes from `id` on (see `Run`). */
function nodesFrom(id: string, count: number): string[] {
  const dot = lastDot(id);
  const prefix = id.slice(0, dot + 1);
  const clock = clockAt(id, dot);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) ids.push(prefix + numberToBase64(clock + i));
  return ids;
}

/** Whether `state` has `keys`, in that order, and no other. */
function hasKeys(state: Record<string, string>, keys: readonly string[]) {
  let index = 0;
  for (const key in state) if (keys[index++] !== key) return false;
  return index === keys.length;
}

/** The batch of a transaction as `Operations`. */
export function encodeOperations(
  ordered: readonly OrderedOperation[],
  patch: StatePatch,
): Operations {
  const only = ordered.length === 1 ? ordered[0]! : undefined;
  if (only?.[0] === 3 && isObjectEmpty(patch)) return encoder.single!(only);
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
    } else if (op[0] === 2) {
      const row: [2, ...NodeRef[]] = [
        2,
        encoder.nodeRef(op[1]),
        encoder.nodeRef(op[2]),
        encoder.nodeRef(op[3]),
        encoder.nodeRef(op[4]),
        encoder.nodeRef(op[5]),
      ];
      rows.push(trimmed(row));
    } else {
      encoder.edit!(op, rows);
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

const NO_SESSIONS: readonly string[] = [];

/** The sessions of the last heads decoded, internalized. */
const recentSessions = ["", "", "", ""];
/** Where the next new session goes, in turn: kept in place, none moves. */
let nextRecent = 0;

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

/** Reads a batch: its head, tree rows and state patch (see `TextDecoder`). */
export class Decoder {
  /** The head's sessions, the first one as `#first` (without its counter). */
  #sessions = NO_SESSIONS;
  #first = "";
  /** The head's counter: nodes written by their distance are from it. */
  #base = 0;
  /** The session and counter the next text row takes without saying them. */
  session = 0;
  next = 0;
  /** The last letter read as a counter or distance, which `"'"` repeats. */
  protected _lastCounter = 0;

  /** Text rows: only the decoder of `text/wire.ts` reads them. */
  textRow?(row: readonly Json[], at: number, ordered: OrderedOperation[]): void;

  /** Starts a batch with its head. */
  reset(head: string | readonly string[]): void {
    const named = typeof head === "string" ? head : head[0]!;
    this.#sessions = typeof head === "string" ? NO_SESSIONS : head;
    const dot = lastDot(named);
    this.#first = dot === -1 ? named : sessionOf(named, dot);
    this.next = dot === -1 ? 0 : base64ToNumber(named, dot + 1);
    this.#base = this.next;
    // The inverse of an edit received has the edit's id: its head is this one.
    if (dot !== -1) encoder.remember(this.#first, this.next, named);
    this.session = 0;
    this._lastCounter = 0;
  }

  /** The node of the first session at `distance` from the head's counter. */
  #at(distance: number): string {
    return `${this.#first}.${numberToBase64(clockOf(distance, this.#base))}`;
  }

  /**
   * A node id, or another session's letter: `"index.counter"` is
   * `session.counter` inside, the counter in base 64 as here, so only the
   * session is looked up.
   */
  node(written: string): string {
    if (written.charCodeAt(0) === 33) return written.slice(1);
    const dot = written.indexOf(".");
    if (dot === -1)
      return isDistance(written) ? this.#at(Number(written)) : written;
    return this.sessionAt(indexBefore(written, dot)) + written.slice(dot);
  }

  sessionAt(index: number): string {
    return index === 0 ? this.#first : this.#sessions[index]!;
  }

  /** A node of a tree row: a number is its distance. */
  nodeRef(value: Json | undefined): string | 0 {
    if (typeof value === "number") return value === 0 ? 0 : this.#at(value);
    return value ? this.node(text(value)) : 0;
  }

  /** A node a tree row must name: `""` where a broken row has none. */
  nodeId(value: Json | undefined): string {
    return this.nodeRef(value) || "";
  }

  /** The tree or text row that starts at `row[at]`, added to `ordered`. */
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
    } else {
      this.textRow!(row, at, ordered);
    }
  }
}

/** Reused by every batch: encoding is not reentrant. */
let encoder = new Encoder();
/** Reused by every batch: decoding is not reentrant. */
let decoder = new Decoder();
/** Fuses the inserts typed one after the other (see `mergeDrafts`). */
let fuse = (ordered: OrderedOperation[]) => ordered;

/**
 * Reads and writes text rows from now on (see `text/wire.ts`). Only a
 * document with text has them, and `defineText` brings them: an app without
 * text does not bundle them.
 */
export function setTextRows(
  textEncoder: Encoder,
  textDecoder: Decoder,
  fuseInserts: typeof fuse,
): void {
  encoder = textEncoder;
  decoder = textDecoder;
  fuse = fuseInserts;
}

/** `ordered` with the inserts typed one after the other fused. */
export const fuseEdits = (ordered: OrderedOperation[]) => fuse(ordered);

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
  if (typeof only === "string" || typeof only === "number") {
    decoder.row(operations, 1, ordered);
    return [ordered, NO_PATCH];
  }
  let patch = NO_PATCH;
  for (let index = 1; index < operations.length; index++) {
    const row = operations[index];
    if (typeof row === "string") {
      const dot = row.indexOf(".");
      decoder.session = indexBefore(row, dot);
      decoder.next = base64ToNumber(row, dot + 1);
    } else if (isList(row)) {
      // The patch is the batch's last row.
      if (row[0] === PATCH) patch = readPatch(row, 1);
      else decoder.row(row, 0, ordered);
    }
  }
  return [ordered, patch];
}

/**
 * @internal - For tests only. What a batch stands for, in order and with whole
 * ids: tests check it against the diff.
 */
export const _INTERNAL_decodeOperations = decodeOperations;
