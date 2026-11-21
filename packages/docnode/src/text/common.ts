import type { Doc } from "../main.js";
import type { EditOperation } from "../operations.js";
import type { InternalStateDefinition, Json } from "../types.js";
import type { SessionTable } from "../columns.js";
import {
  base64ToNumber,
  incrementStringInBase64,
  lastDot,
  numberToBase64,
} from "../idGenerator.js";

/**
 * What the two text engines share: Base's (`text/baseText.ts`, which relies on
 * the server's order) and the CRDT mode's (`text/store.ts`, FugueMax with
 * tombstones), and how `defineText` reaches the one of a document.
 */

export const TEXT_KEY = "~t";

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** A JSON list as a readonly list of JSON, else undefined. */
export const listOf = (value: Json | undefined): readonly Json[] | undefined =>
  Array.isArray(value) ? value : undefined;

/** A string of an operation, or "" where it holds something else. */
export const stringOf = (value: Json | undefined): string =>
  typeof value === "string" ? value : "";

/**
 * The runs of one session sorted by counter. They live in chunks, so a split in
 * the middle of a long history costs a chunk, not the whole list.
 */
export class SessionRuns<
  R extends { readonly c: number; readonly len: number },
> {
  private _chunks: R[][] = [[]];

  private _chunkFor(c: number): R[] {
    const chunks = this._chunks;
    let low = 0;
    let high = chunks.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (chunks[mid]![0]!.c <= c) low = mid;
      else high = mid - 1;
    }
    return chunks[low]!;
  }

  private _last: R | undefined;

  find(c: number): R | undefined {
    const last = this._last;
    if (last !== undefined && c >= last.c && c < last.c + last.len) return last;
    const runs = this._chunkFor(c);
    let low = 0;
    let high = runs.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (runs[mid]!.c <= c) low = mid;
      else high = mid - 1;
    }
    const run = runs[low]!;
    if (c < run.c || c >= run.c + run.len) return undefined;
    this._last = run;
    return run;
  }

  /** Whether any of the `length` ids from `c` is here. */
  overlaps(c: number, length: number): boolean {
    const last = c + length - 1;
    const runs = this._chunkFor(last);
    let low = 0;
    let high = runs.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (runs[mid]!.c <= last) low = mid;
      else high = mid - 1;
    }
    const run = runs[low]!;
    return run.c <= last && run.c + run.len > c;
  }

  /** The counter after its last run. */
  end(): number {
    const runs = this._chunks[this._chunks.length - 1]!;
    const last = runs[runs.length - 1]!;
    return last.c + last.len;
  }

  /** Whether it has no run left (see `remove`). */
  get empty(): boolean {
    return this._chunks.length === 0;
  }

  static from<R extends { readonly c: number; readonly len: number }>(
    runs: R[],
  ): SessionRuns<R> {
    const out = new SessionRuns<R>();
    const count = runs.length;
    const keys = new Float64Array(count);
    let sorted = true;
    for (let index = 0; index < count; index++) {
      const key = runs[index]!.c * count + index;
      keys[index] = key;
      if (index > 0 && keys[index - 1]! > key) sorted = false;
    }
    if (!sorted) {
      keys.sort();
      const unsorted = runs.slice();
      for (let index = 0; index < count; index++) {
        const key = keys[index]!;
        runs[index] = unsorted[key - Math.floor(key / count) * count]!;
      }
    }
    out._chunks = [];
    for (let index = 0; index < runs.length; index += CHUNK)
      out._chunks.push(runs.slice(index, index + CHUNK));
    return out;
  }

  add(run: R): void {
    const runs = this._chunkFor(run.c);
    if (runs.length === 0 || runs[runs.length - 1]!.c < run.c) runs.push(run);
    else runs.splice(lowerBound(runs, run.c), 0, run);
    if (runs.length < CHUNK * 2) return;
    const chunks = this._chunks;
    chunks.splice(chunks.indexOf(runs) + 1, 0, runs.splice(CHUNK));
  }

  remove(run: R): void {
    if (this._last === run) this._last = undefined;
    const runs = this._chunkFor(run.c);
    runs.splice(lowerBound(runs, run.c), 1);
    if (runs.length === 0) this._chunks.splice(this._chunks.indexOf(runs), 1);
  }
}

/** Size at which a chunk of `SessionRuns` is cut in two. */
const CHUNK = 256;

function lowerBound(runs: { readonly c: number }[], c: number): number {
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (runs[mid]!.c < c) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The node id right after `id` (same session, next clock), if it has one. */
export function nextId(id: string): string | undefined {
  const dot = lastDot(id);
  if (dot === -1) return undefined;
  return id.slice(0, dot + 1) + incrementStringInBase64(id.slice(dot + 1));
}

// ----- references to letters ----------------------------------------------
//
// A reference to a letter is a number for one of the operation's own session
// (`counter + 1`), and `session.counter` (base 64) for another one.

export function encodeRef(own: string, s: string, c: number): number | string {
  if (s === own) return c + 1;
  return `${s}.${numberToBase64(c)}`;
}

export function decodeRef(own: string, ref: Json): [string, number] {
  if (typeof ref === "number") return [own, ref - 1];
  const text = stringOf(ref);
  const dot = lastDot(text);
  return [text.slice(0, dot), base64ToNumber(text, dot + 1)];
}

export function pushRange(
  ranges: [string, number, number][],
  s: string,
  c: number,
  len: number,
): void {
  const last = ranges.at(-1);
  if (last?.[0] === s && last[1] + last[2] === c) last[2] += len;
  else ranges.push([s, c, len]);
}

export const encodeRange = (
  own: string,
  s: string,
  c: number,
  len: number,
): Json => (len === 1 ? encodeRef(own, s, c) : [encodeRef(own, s, c), len]);

// ----- the text of a document ------------------------------------------------

/** What `defineText` asks of the text engine of a document. */
export abstract class TextEngine {
  /** The document whose text it holds. */
  abstract bind(doc: Doc): void;
  abstract textOf(node: string): string;
  abstract lengthOf(node: string): number;
  /** The id of the visible letter at `index` of a node's text. */
  abstract letterAt(node: string, index: number): string | undefined;
  /**
   * How many visible letters of a node's text are before letter `letter`,
   * deleted or not. Undefined when the text has no such letter.
   */
  abstract indexOfLetter(node: string, letter: string): number | undefined;
  abstract insert(doc: Doc, node: string, index: number, text: string): void;
  abstract delete(doc: Doc, node: string, index: number, length: number): void;

  /** Applies an edit operation: its inverse, or undefined if nothing changed. */
  abstract apply(doc: Doc, payload: EditOperation): EditOperation | undefined;
  /** What an undo or redo of the history applies. */
  abstract prepareUndo(doc: Doc, undo: EditOperation): EditOperation;
  abstract toJSON(): Json;
  abstract toStored(
    sessions: SessionTable,
    out: { encode(): string }[],
  ): Json[] | 0;
  /** The runs of each list, in order (a tombstone is a `-` per letter). */
  protected abstract _debugRuns(): string[][];
}

const asStore = (value: unknown): TextEngine => {
  if (!(value instanceof TextEngine)) throw new Error("Expected a text store");
  return value;
};

/** The state of the document root that holds an engine's text. */
export function textState(engine: {
  fromJSON(json: unknown): TextEngine;
  fromStored(stored: Json[], columns: string[], sessions: string[]): TextEngine;
}): InternalStateDefinition {
  return {
    fromJSON: (json) => engine.fromJSON(json),
    toJSON: (store) => asStore(store).toJSON(),
    toStored: (store, sessions, columns) =>
      asStore(store).toStored(sessions, columns),
    fromStored: (stored, columns, sessions) =>
      engine.fromStored(stored, columns, sessions),
    applyEdit: (_store, doc, operation) => storeOf(doc).apply(doc, operation),
    prepareUndo: (undo, doc) => storeOf(doc).prepareUndo(doc, undo),
  };
}

/** The text of `doc`: Base's, or that of its CRDT engine (see `textState`). */
export function storeOf(doc: Doc): TextEngine {
  const state: Record<string, unknown> = doc.root["_state"];
  const existing = state[TEXT_KEY];
  if (existing instanceof TextEngine) {
    existing.bind(doc);
    return existing;
  }
  const store = asStore(doc["_editDefinition"]!.fromJSON(undefined));
  store.bind(doc);
  state[TEXT_KEY] = store;
  return store;
}
