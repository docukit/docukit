import type {
  EditOperation,
  Head,
  InsertTextRow,
  LetterRef,
  Operations,
  OperationsRow,
  OrderedOperation,
} from "../operations.js";
import type { Json } from "../types.js";
import { Decoder, Encoder, list, setTextRows, text } from "../wire.js";
import { isList } from "../utils.js";
import { numberToBase64 } from "../idGenerator.js";
import { fuseTextInserts } from "./merge.js";
import { lettersOf } from "./common.js";

// The text rows of the wire format (see `wire.ts`): only a document with
// text reads and writes them, so they come with `defineText`.

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

/** The tag of an edit that inserts letters again with their ids. */
const AGAIN = 4;

/**
 * The tag of an edit that sets the state of letters, which its row starts
 * with: the tag of any other edit starts its row as a negative number.
 */
const STATE = 5;

/** The tag of an edit that sets a key letters inherit, a form of `STATE`. */
const INHERITED = 6;

/** The number a text edit's row starts with (see `STATE`). */
const rowTag = (tag: number) =>
  tag === STATE || tag === INHERITED ? STATE : -tag;

/**
 * A key letters inherit as a `STATE` row writes it, where a key is a string
 * or a number of 0 or more: a number `n` is `-(n + 1)`, any other `[key]`.
 */
function inheritedKey(key: string): Json {
  const written = numericKey(key);
  return typeof written === "number" ? -written - 1 : [written];
}

/** Whether the key of a `STATE` row is one letters inherit (see `inheritedKey`). */
const isInherited = (key: Json | undefined) =>
  isList(key) || (typeof key === "number" && key < 0);

/** The key that `inheritedKey` wrote as `written`. */
const keyInherited = (written: Json | undefined) =>
  typeof written === "number" ? String(-written - 1) : keyOf(list(written)[0]);

/** Whether an insert row can take the next insert: its references are numbers. */
const isJoinable = (row: readonly Json[]): row is Json[] => {
  if (typeof row[0] !== "string") return false;
  for (let at = 1; at < row.length; at++)
    if (typeof row[at] !== "number") return false;
  return true;
};

/**
 * A string after an insert's letters that reads as one of its letters
 * (`"'"`, `"<"`, `"^node"`, `"#hash"` or `"index.counter"`, its counter in
 * base 64): any other is the letters of the next insert of the row.
 */
const LETTER = /^(?:'|<|[#^].*|\d*\.[-\w]+)$/s;

/** A state key as written: a number when it reads as one (`"0"` is `0`). */
const numericKey = (key: string): Json =>
  /^(?:0|[1-9]\d{0,8})$/.test(key) ? Number(key) : key;

/** A state key as read: a number is its digits. */
const keyOf = (key: Json | undefined): string =>
  typeof key === "number" ? String(key) : text(key);

// ----- writing ---------------------------------------------------------------

/** Writes text rows too. */
class TextRowEncoder extends Encoder {
  /** An insert's parent, or Base's left letter: `-1` (none) as it is. */
  #left(ref: Json, c: number): LetterRef {
    return ref === -1 ? -1 : this.ref(ref, c);
  }

  ranges(ranges: Json, c: number): Json {
    if (!isList(ranges)) return this.#rangeRef(ranges, c);
    const out: Json[] = [];
    for (let index = 0; index < ranges.length; index += 2)
      out.push(this.#rangeRef(ranges[index]!, c), ranges[index + 1]!);
    return out;
  }

  /** A letter of a delete: a distance of any sign, as no letter is none. */
  #rangeRef(ref: Json, c: number): LetterRef {
    if (typeof ref !== "number") return this.ref(ref, c);
    this._lastSession = this._session;
    this._lastCounter = ref - 1;
    return c - ref + 1;
  }

  /** The payload of any other text edit (`op[4]` on), after its tag. */
  #payload(op: EditOperation, tag: number, c: number, row: Json[]) {
    // Ranges, then the lamport and the letters brought back, if any.
    if (tag === 1) {
      row.push(this.ranges(op[4]!, c), ...op.slice(5));
      return;
    }
    // Base's state has no lamport: its key, then ranges and their value.
    if (tag === 5) {
      row.push(numericKey(text(op[4])));
      this.#values(op, 5, c, row);
      return;
    }
    // A key letters inherit: one value, then the letter after its ranges.
    if (tag === INHERITED) {
      row.push(inheritedKey(text(op[4])), this.ranges(op[5]!, c), op[6]!);
      if (op.length > 7) row.push(this.ref(op[7]!, c));
      return;
    }
    // `lamport, key`, then ranges and their value, alternately. A key that
    // reads as a number is written as one.
    row.push(op[4]!, numericKey(text(op[5])));
    this.#values(op, 6, c, row);
  }

  /** Ranges and their value, alternately, from `op[from]` on. */
  #values(op: EditOperation, from: number, c: number, row: Json[]) {
    for (let at = from; at < op.length; at += 2) {
      row.push(this.ranges(op[at]!, c));
      if (at + 1 < op.length) row.push(op[at + 1]!);
    }
  }

  /**
   * Letters inserted again with their ids: the letters, their ids (always a
   * list, which an insert's right origin never is) and their state, then the
   * letters around them.
   */
  #again(op: EditOperation, c: number): [string, Json[], ...Json[]] {
    const ids = this.ranges(op[5]!, c);
    const row: [string, Json[], ...Json[]] = [
      text(op[4]),
      isList(ids) ? [...ids] : [ids, 1],
    ];
    if (op.length > 6) row.push(op[6]!);
    for (const ref of op.slice(7)) row.push(this.#left(ref, c));
    return row;
  }

  /** An insert's right origin and parent, after its content. */
  #insertRefs(op: EditOperation, c: number, row: Json[]): void {
    if (op.length > 4) row.push(this.ref(op[4]!, c, ABSOLUTE_RIGHT));
    if (op.length > 5) row.push(this.#left(op[5]!, c));
  }

  /**
   * A batch of only `op`, written straight away: typing and deleting, the
   * batches sent most often. Each array is built at its final length.
   */
  override single(op: EditOperation): Operations {
    const insert = typeof op[1] === "string";
    this.reset(text(insert ? op[1] : op[2]));
    const c = Number(insert ? op[2] : op[3]);
    this.base = c;
    const named = this.#named(c);
    let batch:
      | [Head, string, ...LetterRef[]]
      | [Head, number, ...Json[]]
      | [Head, InsertTextRow]
      | [Head, string, Json[], ...Json[]];
    const content = op[3]!;
    if (!insert) {
      const tag = Number(op[1]);
      const written = rowTag(tag);
      if (tag === AGAIN) batch = [named, ...this.#again(op, c)];
      else if (tag === 1 && op.length === 5)
        batch = [named, written, this.ranges(op[4]!, c)];
      else {
        batch = [named, written];
        this.#payload(op, tag, c, batch);
      }
    } else if (isList(content)) {
      // An insert with attributes keeps its brackets (see `isFlat`).
      const row: [readonly Json[], ...LetterRef[]] = [content];
      this.#insertRefs(op, c, row);
      batch = [named, row];
    } else if (op.length === 4) batch = [named, text(content)];
    else if (op.length === 5)
      batch = [named, text(content), this.ref(op[4]!, c, ABSOLUTE_RIGHT)];
    else
      batch = [
        named,
        text(content),
        this.ref(op[4]!, c, ABSOLUTE_RIGHT),
        this.#left(op[5]!, c),
      ];
    // A reference to another session's letter adds it to the head.
    if (this.others.length > 0) batch[0] = [named, ...this.others];
    return batch;
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
      // (but in a delete, see `#rangeRef`).
      return c - counter;
    }
    const written = text(ref);
    if (written.charCodeAt(0) === 94)
      return `^${this._absolute(written.slice(1))}`;
    return this._absolute(written);
  }

  /**
   * `"session.counter"` of the first session. The inverse of an edit has the
   * edit's own id, so the string of the last one is kept.
   */
  #named(c: number): string {
    if (c === this._lastNamedCounter && this.first === this._lastNamedSession)
      return this._lastNamed;
    if (this.first !== this._prefixed) {
      this._prefixed = this.first;
      this._prefix = `${this.first}.`;
    }
    this.remember(this.first, c, this._prefix + numberToBase64(c));
    return this._lastNamed;
  }

  override edit(op: EditOperation, rows: (Head | OperationsRow)[]): void {
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
      this.#insertRefs(op, c, row);
      this._next = c + lettersOf(content).length;
      if (!isJoinable(row)) {
        rows.push(row);
        return;
      }
      // Inserts one after the other go in one row, without a pair of
      // brackets each, unless the letters read as a reference.
      if (last === undefined || LETTER.test(text(row[0]))) {
        rows.push(row);
        this._joinable = row;
      } else {
        last.push(...row);
        this._joinable = last;
      }
      return;
    }
    const tag = Number(op[1]);
    if (tag === AGAIN) rows.push(this.#again(op, c));
    else {
      const row: [number, ...Json[]] = [rowTag(tag)];
      this.#payload(op, tag, c, row);
      rows.push(row);
    }
    // Only an insert takes ids: the others count from where they are.
    this._next = c;
  }
}

// ----- reading ---------------------------------------------------------------

/** Reads text rows too. */
class TextRowDecoder extends Decoder {
  #rangeRef(value: Json, c: number): Json {
    if (typeof value !== "number") return this.ref(value, c);
    this._lastCounter = c - value;
    return this._lastCounter + 1;
  }

  /** Ranges and their value, alternately, from `row[from]` on. */
  #values(row: readonly Json[], from: number, c: number, op: Json[]) {
    for (let index = from; index < row.length; index += 2) {
      op.push(this.ranges(row[index]!, c));
      if (index + 1 < row.length) op.push(row[index + 1]!);
    }
  }

  /** An insert's parent, or Base's left letter: `-1` (none) as it is. */
  #left(ref: Json, c: number): Json {
    return ref === -1 ? -1 : this.ref(ref, c);
  }

  ranges(ranges: Json, c: number): Json {
    if (!isList(ranges)) return this.#rangeRef(ranges, c);
    const out: Json[] = [];
    for (let index = 0; index < ranges.length; index += 2)
      out.push(this.#rangeRef(ranges[index]!, c), ranges[index + 1]!);
    return out;
  }

  /** The text row that starts at `row[at]`, added to `ordered`. */
  override textRow(
    row: readonly Json[],
    at: number,
    ordered: OrderedOperation[],
  ): void {
    if (typeof row[at] !== "string") {
      ordered.push(this.edit(row, at));
      return;
    }
    // Each insert's letters, then its references: a string that does not
    // read as a letter starts the next one.
    for (let start = at; start < row.length; ) {
      let end = start + 1;
      for (; end < row.length; end++) {
        const next = row[end];
        if (typeof next === "string" && !LETTER.test(next)) break;
      }
      ordered.push(this.edit(row, start, end));
      start = end;
    }
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

  /** An insert's right origin: a number is its counter + 1 (see `ref` of `TextRowEncoder`). */
  right(value: Json, c: number): Json {
    if (value === BACKWARDS) {
      this._lastCounter = c - 1;
      return -c;
    }
    if (typeof value !== "number") return this.ref(value, c);
    if (value !== 0) this._lastCounter = (value < 0 ? -value : value) - 1;
    return value;
  }

  /** The text row that starts at `row[at]` (a batch of one row has it at 1). */
  edit(row: readonly Json[], at: number, end = row.length): EditOperation {
    const c = this.next;
    const session = this.sessionAt(this.session);
    const head = row[at]!;
    const length = end - at;
    if (typeof head !== "number") {
      // Letters inserted again: their ids are a list (see `#again`).
      if (isList(row[at + 1])) return this.#again(row, at, session, c);
      this.next = c + lettersOf(head).length;
      if (length === 1) return [3, session, c, head];
      const right = this.right(row[at + 1]!, c);
      if (length === 2) return [3, session, c, head, right];
      return [3, session, c, head, right, this.#left(row[at + 2]!, c)];
    }
    const tag =
      head !== STATE ? -head : isInherited(row[at + 1]) ? INHERITED : STATE;
    const op: EditOperation = [3, tag, session, c];
    switch (tag) {
      case 1:
        op.push(this.ranges(row[at + 1]!, c), ...row.slice(at + 2));
        break;
      case 2:
        op.push(row[at + 1]!, keyOf(row[at + 2]));
        this.#values(row, at + 3, c, op);
        break;
      case 5:
        op.push(keyOf(row[at + 1]));
        this.#values(row, at + 2, c, op);
        break;
      case INHERITED:
        op.push(
          keyInherited(row[at + 1]),
          this.ranges(row[at + 2]!, c),
          row[at + 3]!,
        );
        if (row.length > at + 4) op.push(this.ref(row[at + 4]!, c));
        break;
      default:
        op.push(...row.slice(at + 1));
    }
    return op;
  }

  /** Letters inserted again with their ids, from `row[at]` (see `#again` of `TextRowEncoder`). */
  #again(
    row: readonly Json[],
    at: number,
    session: string,
    c: number,
  ): EditOperation {
    const op: EditOperation = [3, AGAIN, session, c, row[at]!];
    op.push(this.ranges(row[at + 1]!, c));
    if (row.length > at + 2) op.push(row[at + 2]!);
    for (const ref of row.slice(at + 3)) op.push(this.#left(ref, c));
    return op;
  }
}

let installed = false;

/**
 * Reads and writes text rows from now on: `defineText` calls it, and so do
 * `mergeOperations` and `mergeBatches`, which have no document.
 */
export function useTextRows(): void {
  if (installed) return;
  installed = true;
  setTextRows(new TextRowEncoder(), new TextRowDecoder(), fuseTextInserts);
}
