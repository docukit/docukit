import type {
  DraftOperations,
  EditOperation,
  FlatRow,
  Head,
  InsertTextRow,
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
//   - `[text, right?, left?]` inserts letters after the letter `left` (`-1`:
//     none), `[[text, ...state], right?, left?]` letters with a first state,
//     and `[-tag, ...]` is any other edit (see `text/baseText.ts`): `[-1,
//     ranges]` deletes letters, `[-4, text, ranges, states?, right?, left?]`
//     puts back letters a delete took (`-1`: the id next to them), `[-5, key,
//     ranges, value?, ...]` sets their state, and `[-6, key, ranges, value,
//     right?]` sets a key letters inherit, with the letter that was after the
//     ranges (left out: the id after them). `[-3, text, ...refs, text,
//     ...refs]` is inserts one after the other, each `[text, right?, left?]`
//     without its brackets, when their letters have no state and their
//     references are numbers. Only an insert takes counters.
//   - A letter of the row's own session is a number: the distance back from
//     the row's counter (in a delete, of any sign), but for the right origin
//     of an insert, its counter + 1, negative when the insert is its left
//     child, or `"<"` when the insert is the left child of the letter just
//     before it. `"'"` is the last letter written again. A letter of another
//     session is `"index.counter"`, and `"^node"` is the start of a node's
//     text.
// - `[0, nodes, parent, prev, next]`, `[1, start, end]` and `[2, start, end,
//   parent, prev, next]` insert, delete and move nodes, without their
//   trailing zeros. A row that starts with a number of 0 or more is one of
//   these; a text edit starts with a negative one, an insert with a string or
//   with `[node]`.
// - The state patch, if any, is the last row: `{node: {key: value}}`.
// - A node id `session.clock` is `"index.clock"`; any other id is itself, with a
//   `!` in front if it starts with one, reads as a distance or has a `*` (it
//   would read as a run: see `RUN`). A node of the head's session can be
//   written by its clock's distance `d` from the head's counter instead, when
//   that is not longer (the core does it in batches without text rows): `d +
//   1` from 0 on, `d` below (so `1` is the node at the counter and `-1` the
//   one before). It is a number in a tree row, and a string with its sign
//   anywhere else (`"+1"`, `"-1"`: a key `"1"` would move to the front of the
//   state patch). A batch that inserts a node after the one its author
//   inserted before writes the same rows every time: only the head changes.
// - A batch of one row is written without the row's brackets, unless the
//   row starts with an array (an insert with a first state).

/**
 * An insert's right origin of its own session is written as a counter, not as
 * a distance: typing in a row repeats it from batch to batch, which a
 * compressed stream (`permessage-deflate`) takes advantage of.
 */
const ABSOLUTE_RIGHT = true;

/**
 * An insert's right origin when the insert is the left child of the letter
 * just before it: typing backwards, which a counter would not repeat.
 */
const BACKWARDS = "<";

/**
 * The tag of a row of inserts one after the other (see the format): letters
 * without state whose references are all numbers.
 */
const INSERTS = 3;

/** Whether an insert row can join a row of inserts (see `INSERTS`). */
const isJoinable = (row: readonly Json[]): row is Json[] => {
  if (typeof row[0] !== "string") return false;
  for (let at = 1; at < row.length; at++)
    if (typeof row[at] !== "number") return false;
  return true;
};

const isList = (value: Json | undefined): value is readonly Json[] =>
  Array.isArray(value);

const list = (value: Json | undefined): readonly Json[] =>
  isList(value) ? value : [];

const num = (value: Json | undefined) => Number(value);

const isRecord = (
  value: Json | undefined,
): value is { readonly [Key in string]?: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A state key as written: a number when it reads as one (`"0"` is `0`). */
const numericKey = (key: string): Json =>
  /^(?:0|[1-9]\d{0,8})$/.test(key) ? Number(key) : key;

/** A state key as read: a number is its digits. */
const keyOf = (key: Json | undefined): string =>
  typeof key === "number" ? String(key) : text(key);

/** The letters of an insert's content: `text` or `[text, attrs]`. */
const letters = (content: Json | undefined): string =>
  text(isList(content) ? content[0] : content);

/** A string of the batch, or "" where it holds something else. */
const text = (value: Json | undefined): string =>
  typeof value === "string" ? value : "";

/** Whether `written` is a signed integer: a node by its distance (see the format). */
/** Whether `written` is a signed integer: a node by its distance (see the format). */
const isDistance = (written: string) => /^[+-]\d+$/.test(written);

/** `"ref*n"`: a patch key for `n` nodes from `ref` on (see the format). */
const RUN = /^(.+)\*(\d+)$/;

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
  id.charCodeAt(0) === 33 || isDistance(id) || id.includes("*") ? `!${id}` : id;

/** `id` if it is `session.clock`, with a dot. */
const withSession = (id: string | 0) =>
  id !== 0 && lastDot(id) !== -1 ? id : undefined;

/** A tree row without the zeros at the end of its nodes. */
function trimmed<Row extends unknown[]>(row: Row): Row {
  while (row.length > 2 && row[row.length - 1] === 0) row.pop();
  return row;
}

/** Whether a batch of only `row` leaves out its brackets: not `[[text, ...state]]`. */
const isFlat = (
  row: OperationsRow | undefined,
): row is FlatRow | readonly [string, ...LetterRef[]] =>
  Array.isArray(row) && typeof row[0] !== "object";

/** Up to this many other sessions, a batch finds their index without a map. */
const FEW_SESSIONS = 8;

class Encoder {
  /** The first session of the batch, index 0. */
  first = "";
  /** The other sessions, from index 1. */
  others: string[] = [];
  /** The index of each other session, once there are many. */
  private _indexes: Map<string, number> | undefined;
  /** The counter of the first text row, which the head carries. */
  counter = -1;
  /** The counter the head carries; -1 if none. */
  base = -1;
  /**
   * The counter nodes are written from, -1 for none: with text rows the
   * head's counter is a letter's, far from the clocks of nodes.
   */
  private _from = -1;
  private _session = 0;
  private _next = 0;
  /** The last letter written as a counter or distance, which `"'"` repeats. */
  private _lastSession = -1;
  private _lastCounter = 0;
  /** `"session."` of the last batch of one edit: a session types many. */
  private _prefixed = "";
  private _prefix = ".";
  private _lastNamedSession = "";
  private _lastNamedCounter = -1;
  private _lastNamed = "";
  /**
   * The last row, if it is an insert that a next one can join (see
   * `INSERTS`), and whether it already is a row of inserts.
   */
  private _joinable: Json[] | undefined;
  private _joined = false;

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
    this.base = this._from = dot === -1 ? -1 : clockAt(named, dot);
  }

  /** Starts a batch whose first session is `session`. */
  reset(session: string): void {
    this.first = session;
    // Cheaper than emptying them, which reallocates even when empty.
    if (this.others.length > 0) {
      this.others = [];
      this._indexes = undefined;
    }
    this.counter = -1;
    this.base = -1;
    this._from = -1;
    this._session = 0;
    this._next = 0;
    this._lastSession = -1;
    this._lastCounter = 0;
    this._joinable = undefined;
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

  id(index: number, counter: number): string {
    return `${index || ""}.${numberToBase64(counter)}`;
  }

  /**
   * `session.counter` (or a node id `session.clock`) as `index.counter`: the
   * counter is already in base 64, so it is copied. A node of the first
   * session can be its distance from the head's counter instead (see the
   * format), in a string.
   */
  node(id: string): string {
    const distance = distanceTo(id, this.first, this._from);
    if (distance === 0) return this._absolute(id);
    return distance < 0 ? `${distance}` : `+${distance}`;
  }

  private _absolute(id: string): string {
    const dot = lastDot(id);
    // A star after the dot would read as a run in a patch key.
    if (dot === -1 || id.includes("*", dot)) return literal(id);
    // Cut and compared, a short session is found faster than with
    // `startsWith`.
    const index = this.index(id.slice(0, dot));
    return index === 0 ? id.slice(dot) : `${index}${id.slice(dot)}`;
  }

  /** A node of a tree row: its distance is a number there. */
  nodeRef(id: string | 0): NodeRef {
    if (id === 0) return 0;
    const distance = distanceTo(id, this.first, this._from);
    return distance === 0 ? this._absolute(id) : distance;
  }

  /** A stored reference (see `encodeRef` in the text store) as a wire one. */
  ref(ref: Json, c: number, absolute = false): LetterRef {
    if (typeof ref === "number") {
      if (ref === 0) return 0;
      const left = ref < 0;
      const counter = Math.abs(ref) - 1;
      // Formatting a letter just typed ends the mark at the letter's right
      // origin: the same letter again.
      if (
        !left &&
        this._lastSession === this._session &&
        this._lastCounter === counter
      )
        return "'";
      this._lastSession = this._session;
      this._lastCounter = counter;
      // An insert's right origin is its counter + 1, negative when the insert
      // is its left child: as the text store writes it. Typing backwards,
      // it is the letter just before, which a counter would not repeat.
      if (absolute) return left && counter === c - 1 ? BACKWARDS : ref;
      // A distance repeats more than a counter: a compressed stream takes it.
      // Counters only grow, so an operation's own letters are behind it
      // (but in a delete, see `_rangeRef`).
      return c - counter;
    }
    const written = text(ref);
    if (written.charCodeAt(0) === 94) return `^${this.node(written.slice(1))}`;
    return this.node(written);
  }

  /** A letter of a delete: a distance of any sign, as no letter is none. */
  private _rangeRef(ref: Json, c: number): LetterRef {
    if (typeof ref !== "number") return this.ref(ref, c);
    this._lastSession = this._session;
    this._lastCounter = ref - 1;
    return c - ref + 1;
  }

  ranges(ranges: Json, c: number): Json {
    if (!isList(ranges)) return this._rangeRef(ranges, c);
    const out: Json[] = [];
    for (let index = 0; index < ranges.length; index += 2)
      out.push(this._rangeRef(ranges[index]!, c), ranges[index + 1]!);
    return out;
  }

  edit(op: EditOperation, rows: (Head | OperationsRow)[]): void {
    const insert = typeof op[1] === "string";
    const index = this.index(text(insert ? op[1] : op[2]));
    const c = Number(insert ? op[2] : op[3]);
    // Another row in between (a tree row) ends the row of inserts.
    let last =
      this._joinable === rows[rows.length - 1] ? this._joinable : undefined;
    this._joinable = undefined;
    if (this.counter === -1) this.counter = c;
    else if (index !== this._session || c !== this._next) {
      rows.push(this.id(index, c));
      last = undefined;
    }
    this._session = index;
    if (insert) {
      const content = op[3]!;
      const row: [string | readonly Json[], ...LetterRef[]] = [
        isList(content) ? content : text(content),
      ];
      this._insertRefs(op, c, row);
      this._next = c + letters(content).length;
      if (!isJoinable(row)) {
        rows.push(row);
        return;
      }
      // Inserts one after the other go in one row, without a pair of
      // brackets each.
      if (last === undefined) {
        rows.push(row);
        this._joinable = row;
        this._joined = false;
      } else if (this._joined) {
        last.push(...row);
        this._joinable = last;
      } else {
        const joined: [number, ...Json[]] = [-INSERTS, ...last, ...row];
        rows[rows.length - 1] = joined;
        this._joinable = joined;
        this._joined = true;
      }
      return;
    }
    const tag = Number(op[1]);
    const row: [number, ...Json[]] = [-tag];
    this._payload(op, tag, c, row);
    rows.push(row);
    // Only an insert takes ids: the others count from where they are.
    this._next = c;
  }

  /**
   * A batch of only `op`, written straight away: typing and deleting, the
   * batches sent most often. Each array is built at its final length.
   */
  single(op: EditOperation): Operations {
    const insert = typeof op[1] === "string";
    this.reset(text(insert ? op[1] : op[2]));
    const c = Number(insert ? op[2] : op[3]);
    this.base = c;
    const named = this._named(c);
    let batch:
      | [Head, string, ...LetterRef[]]
      | [Head, number, ...Json[]]
      | [Head, InsertTextRow];
    const content = op[3]!;
    if (!insert) {
      const tag = Number(op[1]);
      const written = -tag;
      if (tag === 1 && op.length === 5)
        batch = [named, written, this.ranges(op[4]!, c)];
      else {
        batch = [named, written];
        this._payload(op, tag, c, batch);
      }
    } else if (isList(content)) {
      // An insert with attributes keeps its brackets (see `isFlat`).
      const row: [readonly Json[], ...LetterRef[]] = [content];
      this._insertRefs(op, c, row);
      batch = [named, row];
    } else if (op.length === 4) batch = [named, text(content)];
    else if (op.length === 5)
      batch = [named, text(content), this.ref(op[4]!, c, ABSOLUTE_RIGHT)];
    else
      batch = [
        named,
        text(content),
        this.ref(op[4]!, c, ABSOLUTE_RIGHT),
        this._left(op[5]!, c),
      ];
    // A reference to another session's letter adds it to the head.
    if (this.others.length > 0) batch[0] = [named, ...this.others];
    return batch;
  }

  /**
   * `"session.counter"` of the first session. The inverse of an edit has the
   * edit's own id, so the string of the last one is kept.
   */
  private _named(c: number): string {
    if (c === this._lastNamedCounter && this.first === this._lastNamedSession)
      return this._lastNamed;
    if (this.first !== this._prefixed) {
      this._prefixed = this.first;
      this._prefix = `${this.first}.`;
    }
    this.remember(this.first, c, this._prefix + numberToBase64(c));
    return this._lastNamed;
  }

  /** `named` is `"session.counter"`: the head of a batch just read or written. */
  remember(session: string, c: number, named: string): void {
    this._lastNamedSession = session;
    this._lastNamedCounter = c;
    this._lastNamed = named;
  }

  /** An insert's right origin and left letter, after its content. */
  private _insertRefs(op: EditOperation, c: number, row: Json[]): void {
    if (op.length > 4) row.push(this.ref(op[4]!, c, ABSOLUTE_RIGHT));
    if (op.length > 5) row.push(this._left(op[5]!, c));
  }

  /** An insert's left letter: `-1` (none) as it is. */
  private _left(ref: Json, c: number): LetterRef {
    return ref === -1 ? -1 : this.ref(ref, c);
  }

  /** The payload of any other text edit (`op[4]` on), after its tag. */
  private _payload(op: EditOperation, tag: number, c: number, row: Json[]) {
    // Ranges, then the lamport and the letters brought back, if any.
    if (tag === 1) {
      row.push(this.ranges(op[4]!, c), ...op.slice(5));
      return;
    }
    // The letters, their ids and state, then the letters around them.
    if (tag === 4) {
      row.push(op[4]!, this.ranges(op[5]!, c));
      if (op.length > 6) row.push(op[6]!);
      for (const ref of op.slice(7)) row.push(this._left(ref, c));
      return;
    }
    // Base's state has no lamport: its key, then ranges and their value.
    if (tag === 5) {
      row.push(numericKey(text(op[4])));
      this._values(op, 5, c, row);
      return;
    }
    // A key letters inherit: one value, then the letter after its ranges.
    row.push(numericKey(text(op[4])), this.ranges(op[5]!, c), op[6]!);
    if (op.length > 7) row.push(this.ref(op[7]!, c));
  }

  /** Ranges and their value, alternately, from `op[from]` on. */
  private _values(op: EditOperation, from: number, c: number, row: Json[]) {
    for (let at = from; at < op.length; at += 2) {
      row.push(this.ranges(op[at]!, c));
      if (at + 1 < op.length) row.push(op[at + 1]!);
    }
  }
}

/** Reused by every batch: encoding is not reentrant. */
const encoder = new Encoder();

/** The batch of a transaction as `Operations`. */
export function encodeOperations(
  ordered: readonly OrderedOperation[],
  patch: StatePatch,
): Operations {
  const only = ordered.length === 1 ? ordered[0]! : undefined;
  if (only?.[0] === 3 && isObjectEmpty(patch)) return encoder.single(only);
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
      const row: [0, typeof nodes, ...NodeRef[]] = [
        0,
        nodes,
        encoder.nodeRef(op[2]),
        encoder.nodeRef(op[3]),
        encoder.nodeRef(op[4]),
      ];
      rows.push(trimmed(row));
    } else if (op[0] === 1) {
      const row: [1, ...NodeRef[]] = [
        1,
        encoder.nodeRef(op[1]),
        encoder.nodeRef(op[2]),
      ];
      rows.push(trimmed(row));
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
      encoder.edit(op, rows);
    }
  }
  // Read once: a patch has a key per node id, each one new to the engine.
  const ids: string[] = [];
  const states: Record<string, string>[] = [];
  for (const id in patch) {
    ids.push(id);
    states.push(patch[id]!);
  }
  const values: Record<string, StatePatchRow[string]> = {};
  for (let at = 0; at < ids.length; ) {
    const written = states[at]!;
    const length = runLength(ids, states, at);
    if (length < 3) {
      const state: Record<string, Json> = {};
      for (const key in written) state[key] = parseJson(written[key]!);
      values[encoder.node(ids[at]!)] = state;
      at++;
      continue;
    }
    // Nodes one after the other with the same keys: a column per key.
    const columns: Record<string, Json[]> = {};
    for (const key in written) {
      const column: Json[] = [];
      for (let i = at; i < at + length; i++)
        column.push(parseJson(states[i]![key]!));
      columns[key] = column;
    }
    values[`${encoder.node(ids[at]!)}*${length}`] = columns;
    at += length;
  }
  if (ids.length > 0) rows.push(values);
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

/** The sessions of the last heads decoded, internalized. */
const recentSessions = ["", "", "", ""];
/** Where the next new session goes, in turn: kept in place, none moves. */
let nextRecent = 0;

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

class Decoder {
  /** The head's sessions, the first one as `_first` (without its counter). */
  private _sessions = NO_SESSIONS;
  private _first = "";
  /** The head's counter: nodes written by their distance are from it. */
  private _base = 0;
  session = 0;
  next = 0;
  private _lastCounter = 0;

  /** Starts a batch with its head. */
  reset(head: string | readonly string[]): void {
    const named = typeof head === "string" ? head : head[0]!;
    this._sessions = typeof head === "string" ? NO_SESSIONS : head;
    const dot = lastDot(named);
    this._first = dot === -1 ? named : sessionOf(named, dot);
    this.next = dot === -1 ? 0 : base64ToNumber(named, dot + 1);
    this._base = this.next;
    // The inverse of an edit received has the edit's id: its head is this one.
    if (dot !== -1) encoder.remember(this._first, this.next, named);
    this.session = 0;
    this._lastCounter = 0;
  }

  sessionAt(index: number): string {
    return index === 0 ? this._first : this._sessions[index]!;
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
      return isDistance(written) ? this._at(Number(written)) : written;
    return this.sessionAt(indexBefore(written, dot)) + written.slice(dot);
  }

  /** The node of the first session at `distance` from the head's counter. */
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

  ref(value: Json, c: number): Json {
    if (typeof value === "number") {
      if (value === 0) return 0;
      this._lastCounter = c - value;
      return this._lastCounter + 1;
    }
    const written = text(value);
    switch (written.charCodeAt(0)) {
      case 39: // '
        return this._lastCounter + 1;
      case 94: // ^
        return `^${this.node(written.slice(1))}`;
    }
    return this.node(written);
  }

  /** An insert's right origin: a number is its counter + 1 (see `Encoder`). */
  right(value: Json, c: number): Json {
    if (value === BACKWARDS) {
      this._lastCounter = c - 1;
      return -c;
    }
    if (typeof value !== "number") return this.ref(value, c);
    if (value !== 0) this._lastCounter = (value < 0 ? -value : value) - 1;
    return value;
  }

  private _rangeRef(value: Json, c: number): Json {
    if (typeof value !== "number") return this.ref(value, c);
    this._lastCounter = c - value;
    return this._lastCounter + 1;
  }

  ranges(ranges: Json, c: number): Json {
    if (!isList(ranges)) return this._rangeRef(ranges, c);
    const out: Json[] = [];
    for (let index = 0; index < ranges.length; index += 2)
      out.push(this._rangeRef(ranges[index]!, c), ranges[index + 1]!);
    return out;
  }

  /** The text row that starts at `row[at]` (a batch of one row has it at 1). */
  edit(row: readonly Json[], at: number, end = row.length): EditOperation {
    const c = this.next;
    const session = this.sessionAt(this.session);
    const head = row[at]!;
    const length = end - at;
    if (typeof head !== "number") {
      this.next = c + letters(head).length;
      if (length === 1) return [3, session, c, head];
      const right = this.right(row[at + 1]!, c);
      if (length === 2) return [3, session, c, head, right];
      const left = row[at + 2]!;
      return [3, session, c, head, right, left === -1 ? -1 : this.ref(left, c)];
    }
    const tag = -head;
    const op: EditOperation = [3, tag, session, c];
    switch (tag) {
      case 1:
        op.push(this.ranges(row[at + 1]!, c), ...row.slice(at + 2));
        break;
      case 4:
        op.push(row[at + 1]!, this.ranges(row[at + 2]!, c));
        if (row.length > at + 3) op.push(row[at + 3]!);
        for (const ref of row.slice(at + 4))
          op.push(ref === -1 ? -1 : this.ref(ref, c));
        break;
      case 5:
        op.push(keyOf(row[at + 1]));
        this._values(row, at + 2, c, op);
        break;
      case 6:
        op.push(keyOf(row[at + 1]), this.ranges(row[at + 2]!, c), row[at + 3]!);
        if (row.length > at + 4) op.push(this.ref(row[at + 4]!, c));
        break;
      default:
        op.push(...row.slice(at + 1));
    }
    return op;
  }

  /** Ranges and their value, alternately, from `row[from]` on. */
  private _values(row: readonly Json[], from: number, c: number, op: Json[]) {
    for (let index = from; index < row.length; index += 2) {
      op.push(this.ranges(row[index]!, c));
      if (index + 1 < row.length) op.push(row[index + 1]!);
    }
  }

  /** The tree or text row that starts at `row[at]`, added to `ordered`. */
  row(row: readonly Json[], at: number, ordered: OrderedOperation[]): void {
    const tag = row[at];
    const N = (offset: number) => this.nodeRef(row[at + offset]);
    if (tag === 0) {
      const nodes: [string, string][] = [];
      const first = row[at + 1];
      if (isList(first))
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
      ordered.push([1, this.nodeId(row[at + 1]), N(2)]);
    } else if (tag === 2) {
      ordered.push([2, this.nodeId(row[at + 1]), N(2), N(3), N(4), N(5)]);
    } else if (tag === -INSERTS) {
      // Each insert's letters, then its references, which are numbers.
      for (let start = at + 1; start < row.length; ) {
        let end = start + 1;
        while (end < row.length && typeof row[end] === "number") end++;
        ordered.push(this.edit(row, start, end));
        start = end;
      }
    } else {
      ordered.push(this.edit(row, at));
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

/** The ordered operations and state patch that `Operations` stands for. */
export function decodeOperations(operations: Operations): DraftOperations {
  decoder.reset(operations[0]);
  const ordered: OrderedOperation[] = [];
  const only = operations[1];
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
      decoder.row(row, 0, ordered);
    } else if (isRecord(row)) {
      // The patch is the batch's last row. Keyed by nodes of a session, new
      // ids each time, it is a dictionary; by an id like the root's, a plain
      // object (see `idRecord`).
      let fresh: StatePatch | undefined;
      for (const id in row) {
        fresh ??= lastDot(id) === -1 && !isDistance(id) ? {} : idRecord();
        const written = row[id];
        const values = isRecord(written) ? written : {};
        const run = id.charCodeAt(0) === 33 ? null : RUN.exec(id);
        if (run) {
          // A column per key, a value per node from the first one on.
          const ids = nodesFrom(decoder.node(run[1]!), Number(run[2]));
          for (let i = 0; i < ids.length; i++) {
            const state: Record<string, string> = {};
            for (const key in values)
              state[key] = stringifyJson(list(values[key])[i]);
            fresh[ids[i]!] = state;
          }
          continue;
        }
        const state: Record<string, string> = {};
        for (const key in values) state[key] = stringifyJson(values[key]);
        fresh[decoder.node(id)] = state;
      }
      patch = fresh ?? {};
    }
  }
  return [ordered, patch];
}

/**
 * @internal - For tests only. What a batch stands for, in order and with whole
 * ids: tests check it against the diff.
 */
export const _INTERNAL_decodeOperations = decodeOperations;
