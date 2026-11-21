import { clockAt, lastDot, numberToBase64 } from "./idGenerator.js";

/**
 * Numbers of a stored document (its tree and its text), as JSON strings.
 *
 * A number is written in base 93, with the characters JSON does not escape
 * (from " " to "~", without `"` and `\`), and a cut T: a digit below T ends
 * the number, one at or above it continues it in base 93 - T. A high cut fits
 * more values in one character, a low one makes larger values shorter.
 *
 * - A column holds one field of many records. Its first character says
 *   whether it holds runs of one value (`value, times`) and the cut it
 *   picked. The zeros at its end are not written: a column of zeros is empty.
 * - A field stream holds several fields one after the other, each with the
 *   fixed cut of its field: it is written as it goes, with no second pass.
 */
const BASE = 93;
const DIGITS = new Uint8Array(BASE);
const VALUES = new Uint8Array(128);
for (let code = 32, digit = 0; code < 127; code++) {
  if (code === 34 || code === 92) continue;
  DIGITS[digit] = code;
  VALUES[code] = digit++;
}
const ASCII = new TextDecoder();

const NO_VALUES = new Int32Array(0);
const NO_WIDE_VALUES = new Float64Array(0);

/** The cuts a column tries, from many one-digit values to large ones. */
const CUTS = [2, 4, 8, 16, 32, 48, 64, 80];
/** A column picks its cut on this many of its values. */
const SAMPLE = 256;

/** The numbers of a column, as they are stored. */
export class ColumnWriter {
  private _values: Int32Array | Float64Array;
  private _count = 0;
  private _changes = 0;

  /**
   * `capacity`: how many values it will likely hold, taken at the first
   * push, so that a column with many values does not grow again and again.
   * `wide`: it holds any whole number up to `Number.MAX_SAFE_INTEGER`, not
   * only those of 32 bits.
   * `keepZeros`: its zeros at the end are written, for a column read until
   * it is done (see `ColumnReader.done`).
   */
  constructor(
    private readonly _capacity = 64,
    private readonly _wide = false,
    private readonly _keepZeros = false,
  ) {
    this._values = _wide ? NO_WIDE_VALUES : NO_VALUES;
  }

  push(value: number): void {
    const count = this._count;
    if (count === this._values.length) {
      const size = count * 2 || this._capacity;
      const grown = this._wide ? new Float64Array(size) : new Int32Array(size);
      grown.set(this._values);
      this._values = grown;
    }
    if (count === 0 || value !== this._values[count - 1]) this._changes++;
    this._values[count] = value;
    this._count = count + 1;
  }

  /** A value that may be negative: 0, -1, 1, -2… as 0, 1, 2, 3… */
  pushSigned(value: number): void {
    this.push(value < 0 ? -2 * value - 1 : 2 * value);
  }

  encode(): string {
    let values = this._values;
    let count = this._count;
    // A reader past the end reads zeros.
    if (!this._keepZeros) while (count > 0 && values[count - 1] === 0) count--;
    if (count === 0) return "";
    // Runs of one value, as `value, times`, when they take fewer numbers.
    const runs = this._changes * 2 < count;
    if (runs) {
      const pairs = new Float64Array(this._changes * 2);
      let at = 0;
      for (let index = 0; index < count; ) {
        const value = values[index]!;
        let end = index + 1;
        while (end < count && values[end] === value) end++;
        pairs[at++] = value;
        pairs[at++] = end - index;
        index = end;
      }
      values = pairs;
      count = at;
    }
    // The cut that takes the fewest digits, on a sample.
    const step = Math.ceil(count / SAMPLE);
    let cutIndex = 0;
    let best = Infinity;
    for (const [index, candidate] of CUTS.entries()) {
      const scale = BASE - candidate;
      let size = 0;
      for (let index = 0; index < count && size < best; index += step) {
        size++;
        let value = values[index]!;
        for (; value >= candidate; size++)
          value = Math.floor((value - candidate) / scale);
      }
      if (size < best) [cutIndex, best] = [index, size];
    }
    const cut = CUTS[cutIndex]!;
    const out = new FieldWriter(Math.ceil(best * step * 1.25) + 10);
    // One digit: whether it holds runs, and the cut.
    out.write(runs ? CUTS.length + cutIndex : cutIndex, BASE);
    for (let index = 0; index < count; index++) out.write(values[index]!, cut);
    return out.encode();
  }
}

/** Writes a number with `cut` at `at`, and returns where it ends. */
function writeNumber(
  bytes: Uint8Array,
  at: number,
  value: number,
  cut: number,
): number {
  if (value < cut) {
    bytes[at] = DIGITS[value]!;
    return at + 1;
  }
  const scale = BASE - cut;
  // Above 31 bits, `| 0` would cut the quotient.
  while (value > 0x7fffffff) {
    const rest = value - cut;
    const next = Math.floor(rest / scale);
    bytes[at++] = DIGITS[cut + rest - next * scale]!;
    value = next;
  }
  while (value >= cut) {
    const rest = value - cut;
    const next = (rest / scale) | 0;
    bytes[at++] = DIGITS[cut + rest - next * scale]!;
    value = next;
  }
  bytes[at++] = DIGITS[value]!;
  return at;
}

/** Fields of different kinds, one after the other, each with its own cut. */
export class FieldWriter {
  private _bytes: Uint8Array;
  private _at = 0;

  constructor(capacity = 1024) {
    this._bytes = new Uint8Array(capacity);
  }

  write(value: number, cut: number): void {
    // A safe integer never takes more than 15 digits (with the lowest scale).
    if (this._at + 15 > this._bytes.length) {
      const grown = new Uint8Array(this._bytes.length * 2);
      grown.set(this._bytes);
      this._bytes = grown;
    }
    this._at = writeNumber(this._bytes, this._at, value, cut);
  }

  /** A value that may be negative: 0, -1, 1, -2… as 0, 1, 2, 3… */
  writeSigned(value: number, cut: number): void {
    this.write(value < 0 ? -2 * value - 1 : 2 * value, cut);
  }

  encode(): string {
    return ASCII.decode(this._bytes.subarray(0, this._at));
  }

  clear(): void {
    this._at = 0;
  }
}

/** 0, 1, 2, 3… back to 0, -1, 1, -2… */
const signed = (value: number) => (value % 2 ? -(value + 1) / 2 : value / 2);

/** Reads what a `FieldWriter` wrote, in the same order and with the same cuts. */
export class FieldReader {
  private readonly _text: string;
  private _at = 0;

  constructor(text: string) {
    this._text = text;
  }

  /** Where the next number starts. */
  get position(): number {
    return this._at;
  }

  set position(at: number) {
    this._at = at;
  }

  get done(): boolean {
    return this._at >= this._text.length;
  }

  read(cut: number): number {
    const text = this._text;
    const scale = BASE - cut;
    let value = 0;
    let weight = 1;
    for (;;) {
      const digit = VALUES[text.charCodeAt(this._at++)]!;
      value += digit * weight;
      if (digit < cut) return value;
      weight *= scale;
    }
  }

  readSigned(cut: number): number {
    return signed(this.read(cut));
  }
}

/**
 * Reads a column written by `ColumnWriter`, one number at a time: past its
 * end, zeros.
 */
export class ColumnReader {
  private readonly _numbers: FieldReader;
  private readonly _runs: boolean = false;
  private readonly _cut: number = 0;
  private _left = 0;
  private _value = 0;

  constructor(text: string) {
    this._numbers = new FieldReader(text);
    if (text === "") return;
    const head = this._numbers.read(BASE);
    this._runs = head >= CUTS.length;
    this._cut = CUTS[head % CUTS.length]!;
  }

  next(): number {
    const numbers = this._numbers;
    if (numbers.done && this._left === 0) return 0;
    if (!this._runs) return numbers.read(this._cut);
    if (this._left === 0) {
      this._value = this._numbers.read(this._cut);
      this._left = this._numbers.read(this._cut);
    }
    this._left--;
    return this._value;
  }

  nextSigned(): number {
    return signed(this.next());
  }

  get done(): boolean {
    return this._left === 0 && this._numbers.done;
  }
}

/** The cut of the lengths that `joinColumns` writes before each column. */
const LENGTH_CUT = 64;

/**
 * One string with every column, each with its length in front. Joined, not
 * concatenated: a flat string keeps `JSON.stringify` on its fast path.
 */
export function joinColumns(columns: { encode(): string }[]): string {
  const encoded = columns.map((column) => column.encode());
  while (encoded.at(-1) === "") encoded.pop();
  const lengths = new FieldWriter(encoded.length * 2);
  const parts: string[] = [];
  for (const column of encoded) {
    lengths.write(column.length, LENGTH_CUT);
    parts.push(lengths.encode(), column);
    lengths.clear();
  }
  return parts.join("");
}

/**
 * The columns joined by `joinColumns`: `count` of them (the missing ones
 * empty), or all that were written.
 */
export function splitColumns(text: string, count = Infinity): string[] {
  const lengths = new FieldReader(text);
  const columns: string[] = [];
  let at = 0;
  for (let field = 0; field < count; field++) {
    // Past the last column written, the rest are empty.
    if (at >= text.length && count === Infinity) break;
    const length = at < text.length ? lengths.read(LENGTH_CUT) : 0;
    at = lengths.position;
    columns.push(text.slice(at, at + length));
    at += length;
    lengths.position = at;
  }
  return columns;
}

/**
 * Each entry without the start it shares with the one before (`first` for
 * the first entry), whose length goes in `shared`.
 */
export function frontCode(
  entries: readonly string[],
  first: string,
  shared: ColumnWriter,
): string[] {
  let before = first;
  return entries.map((entry) => {
    const end = Math.min(entry.length, before.length);
    let length = 0;
    while (
      length < end &&
      entry.charCodeAt(length) === before.charCodeAt(length)
    )
      length++;
    shared.push(length);
    before = entry;
    return length === 0 ? entry : entry.slice(length);
  });
}

/** The entries `frontCode` wrote. */
export function frontDecode(
  entries: readonly string[],
  first: string,
  shared: ColumnReader,
): string[] {
  let before = first;
  return entries.map(
    (entry) => (before = before.slice(0, shared.next()) + entry),
  );
}

/**
 * The sessions of a stored document, each once, shared by its tree, its
 * text and its CRDT engine. One with a dot is written `index.rest`, the
 * index of what comes before its last dot (often a node id after its
 * session).
 */
export class SessionTable {
  readonly table: string[] = [];
  /** The clock of the last id `node` split, plus one, or 0. */
  clock = 0;
  private readonly _indexes = new Map<string, number>();
  // Ids in a row mostly share a session: the last one found is kept.
  private _last: string | undefined;
  private _lastIndex = 0;

  /**
   * The index of a node id's session, with its clock in `clock`. An id is
   * `session.clock` when its clock is written as the default generator
   * writes it, with up to 4 digits (16.7 million ids per session, which
   * keeps it in a column); else it is a session alone.
   */
  node(id: string): number {
    const dot = lastDot(id);
    const clock = dot === -1 ? -1 : clockAt(id, dot, 4);
    if (clock < 0) {
      this.clock = 0;
      return this.index(id);
    }
    this.clock = clock + 1;
    // Ids in a row mostly share a session. Cut and compared, a short session
    // is found faster than with `startsWith`.
    const session = id.slice(0, dot);
    if (session === this._last) return this._lastIndex;
    return this.index(session);
  }

  index(session: string): number {
    if (session === this._last) return this._lastIndex;
    let index = this._indexes.get(session);
    if (index === undefined) {
      const dot = lastDot(session);
      const prefix = dot === -1 ? undefined : this.index(session.slice(0, dot));
      index = this.table.length;
      this.table.push(
        prefix === undefined ? session : `${prefix || ""}${session.slice(dot)}`,
      );
      this._indexes.set(session, index);
    }
    this._last = session;
    this._lastIndex = index;
    return index;
  }
}

/** The sessions a `SessionTable` wrote. */
export function readSessions(table: readonly string[]): string[] {
  const sessions: string[] = [];
  for (const entry of table) {
    const dot = entry.indexOf(".");
    sessions.push(
      dot === -1
        ? entry
        : sessions[Number(entry.slice(0, dot))]! + entry.slice(dot),
    );
  }
  return sessions;
}

/** The id that `SessionTable.node` split. */
export const joinId = (session: string, clock: number): string =>
  clock === 0 ? session : `${session}.${numberToBase64(clock - 1)}`;
