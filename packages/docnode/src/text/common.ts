import type { Doc } from "../main.js";
import type { EditOperation } from "../operations.js";
import type { InternalStateDefinition, Json, StoredLetters } from "../types.js";
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

export type TextSpan = { text: string; attrs: Record<string, Json> };

export const TEXT_KEY = "~t";

/**
 * How a letter without a value of its own for a key gets it:
 *
 * - `"origin"`: the value of the letter it was typed after.
 * - `"both"`: that value, only if the letter after it has the same. Typing
 *   at the edge of a link stays out of it, typing inside it stays in.
 *
 * A key without a rule is only what was written on the letter.
 */
export type Inherit = "origin" | "both";
/** By key; a key ending in `*` names every key that starts with the rest. */
export type InheritRules = Readonly<Record<string, Inherit>>;
export type Rules = {
  get(key: string): Inherit | undefined;
  /** Letters of these characters inherit nothing (see `defineText`). */
  readonly opaque: string;
};

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

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The rules of each `defineText` definition that has them. */
export const inheritRules = new WeakMap<object, Rules>();

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function decodeRef(own: string, ref: Json): [string, number] {
  if (typeof ref === "number") return [own, ref - 1];
  const text = stringOf(ref);
  if (text.charCodeAt(0) === 94) return [text.slice(1), -1];
  const dot = lastDot(text);
  return [text.slice(0, dot), base64ToNumber(text, dot + 1)];
}

/**
 * The rules of `inherit` (see `InheritRules`), and the opaque letters; none
 * without a key.
 */
export function rulesOf(
  inherit: InheritRules = {},
  opaque = "",
): Rules | undefined {
  const exact = new Map<string, Inherit>();
  const prefixes: [string, Inherit][] = [];
  for (const [key, rule] of Object.entries(inherit))
    if (key.endsWith("*")) prefixes.push([key.slice(0, -1), rule]);
    else exact.set(key, rule);
  if (exact.size + prefixes.length === 0) return undefined;
  return {
    get: (key) =>
      exact.get(key) ??
      (prefixes.length === 0
        ? undefined
        : prefixes.find(([prefix]) => key.startsWith(prefix))?.[1]),
    opaque,
  };
}

export const sameValue = (a: Json, b: Json) =>
  a === b ||
  (typeof a === "object" &&
    typeof b === "object" &&
    JSON.stringify(a) === JSON.stringify(b));

/** A JSON list as a readonly list of JSON, else undefined. */
export const listOf = (value: Json | undefined): readonly Json[] | undefined =>
  Array.isArray(value) ? value : undefined;

/** A string of an operation, or "" where it holds something else. */
export const stringOf = (value: Json | undefined): string =>
  typeof value === "string" ? value : "";

/** The letters of an insert's content (`text` or `[text, ...state]`), or "". */
export const lettersOf = (content: Json | undefined): string =>
  stringOf(listOf(content)?.[0] ?? content);

export const isRecord = (
  value: Json | undefined,
): value is { readonly [key: string]: Json | undefined } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The first state an insert's content gives its letters: the content after
 * the text (see `contentOf`). A string names keys of one character set to
 * 1. A `null` value is kept: the letters have no value for the key,
 * inherited or not.
 */
export function stateOfContent(
  content: Json | undefined,
): Record<string, Json> | undefined {
  const parts = listOf(content);
  if (!parts) return undefined;
  const state: Record<string, Json> = {};
  let any = false;
  for (const part of parts.slice(1)) {
    if (typeof part === "string")
      for (const key of part) {
        state[key] = 1;
        any = true;
      }
    else if (isRecord(part))
      for (const key in part) {
        state[key] = part[key]!;
        any = true;
      }
  }
  return any ? state : undefined;
}

/** Where the first opaque letter of `text` is, or its length. */
export function cutIn(text: string, opaque: string): number {
  if (opaque === "") return text.length;
  for (let index = 0; index < text.length; index++)
    if (opaque.includes(text[index]!)) return index;
  return text.length;
}

/**
 * The runs of one session sorted by counter. They live in chunks, so a split in
 * the middle of a long history costs a chunk, not the whole list.
 */
export class SessionRuns<
  R extends { readonly c: number; readonly len: number },
> {
  #chunks: R[][] = [[]];

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
    out.#chunks = [];
    for (let index = 0; index < runs.length; index += CHUNK)
      out.#chunks.push(runs.slice(index, index + CHUNK));
    return out;
  }

  #last: R | undefined;

  #chunkFor(c: number): R[] {
    const chunks = this.#chunks;
    let low = 0;
    let high = chunks.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (chunks[mid]![0]!.c <= c) low = mid;
      else high = mid - 1;
    }
    return chunks[low]!;
  }

  /** Whether any of the `length` ids from `c` is here. */
  overlaps(c: number, length: number): boolean {
    const last = c + length - 1;
    const run = this.#startingBy(last);
    return run.c <= last && run.c + run.len > c;
  }

  /** The counter after its last run. */
  end(): number {
    const runs = this.#chunks[this.#chunks.length - 1]!;
    const last = runs[runs.length - 1]!;
    return last.c + last.len;
  }

  /** The last run that starts at `c` or before it, else the first one. */
  #startingBy(c: number): R {
    const runs = this.#chunkFor(c);
    let low = 0;
    let high = runs.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (runs[mid]!.c <= c) low = mid;
      else high = mid - 1;
    }
    return runs[low]!;
  }

  add(run: R): void {
    const runs = this.#chunkFor(run.c);
    if (runs.length === 0 || runs[runs.length - 1]!.c < run.c) runs.push(run);
    else runs.splice(lowerBound(runs, run.c), 0, run);
    if (runs.length < CHUNK * 2) return;
    const chunks = this.#chunks;
    chunks.splice(chunks.indexOf(runs) + 1, 0, runs.splice(CHUNK));
  }

  find(c: number): R | undefined {
    const last = this.#last;
    if (last !== undefined && c >= last.c && c < last.c + last.len) return last;
    const run = this.#startingBy(c);
    if (c < run.c || c >= run.c + run.len) return undefined;
    this.#last = run;
    return run;
  }

  remove(run: R): void {
    if (this.#last === run) this.#last = undefined;
    const runs = this.#chunkFor(run.c);
    runs.splice(lowerBound(runs, run.c), 1);
    if (runs.length === 0) this.#chunks.splice(this.#chunks.indexOf(runs), 1);
  }

  /** Whether it has no run left (see `remove`). */
  get empty(): boolean {
    return this.#chunks.length === 0;
  }
}

/** Size at which a chunk of `SessionRuns` is cut in two. */
const CHUNK = 256;

/** The node id right after `id` (same session, next clock), if it has one. */
export function nextId(id: string): string | undefined {
  const dot = lastDot(id);
  if (dot === -1) return undefined;
  return id.slice(0, dot + 1) + incrementStringInBase64(id.slice(dot + 1));
}

/** The rules of a node's type, `false` while it is not in the document. */
export function rulesOfNode(
  doc: Doc | undefined,
  node: string,
): Rules | undefined | false {
  const found = doc?.getNodeById(node);
  if (!found) return false;
  const definition = doc!["_resolvedNodeDefs"].get(found.type);
  for (const key in definition?.state) {
    const rules = inheritRules.get(definition.state[key]!);
    if (rules) return rules;
  }
  return undefined;
}

/**
 * An insert's content: its text, or `[text, flags?, attrs?]` with the first
 * state of its letters, where `flags` are the keys of one character set to
 * 1 (a format, like bold) and `attrs` the rest (`null`: none, not inherited).
 */
export function contentOf(
  text: string,
  attrs: Readonly<Record<string, Json>> | undefined,
): Json {
  if (!attrs) return text;
  let flags = "";
  let rest: Record<string, Json> | undefined;
  for (const key in attrs) {
    const value = attrs[key]!;
    if (key.length === 1 && value === 1) flags += key;
    else (rest ??= {})[key] = value;
  }
  // `attrs` has a key at least: the engines send none without one.
  if (!rest) return [text, flags];
  return flags === "" ? [text, rest] : [text, flags, rest];
}

// ----- references to letters ----------------------------------------------
//
// A reference to an element is a number for one of the operation's own
// session (`counter + 1`), `session.counter` (base 64) for another one, and
// `^node` for the start of a node's text.

export function encodeRef(own: string, s: string, c: number): number | string {
  if (s === own) return c + 1;
  if (c === -1) return `^${s}`;
  return `${s}.${numberToBase64(c)}`;
}

/** The state of the document root that holds an engine's text. */
export function textState(engine: {
  fromJSON(json: unknown): TextEngine;
  fromStored(
    stored: Json[],
    columns: string[],
    sessions: string[],
    root: string,
  ): TextEngine;
  /** How many columns `toStored` wrote, by what it returned. */
  columns(stored: Json[]): number;
}): InternalStateDefinition {
  return {
    fromJSON: (json) => engine.fromJSON(json),
    toJSON: (store) => asStore(store).toJSON(),
    toStored: (store, sessions, columns, root) =>
      asStore(store).toStored(sessions, columns, root),
    storedColumns: (stored) => engine.columns(stored),
    fromStored: (stored, columns, sessions, root) =>
      engine.fromStored(stored, columns, sessions, root),
    applyEdit: (_store, doc, operation) => storeOf(doc).apply(doc, operation),
    prepareUndo: (undo, doc) => storeOf(doc).prepareUndo(doc, undo),
  };
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
  /** The document whose nodes say the inherit rules of their text. */
  abstract bind(doc: Doc): void;
  /** The inherit rules of a node, known before it is in the document. */
  abstract setRules(node: string, rules: Rules | undefined): void;
  abstract textOf(node: string): string;
  abstract spansOf(node: string): TextSpan[];
  abstract lengthOf(node: string): number;
  /** The id of the visible letter at `index` of a node's text. */
  abstract letterAt(node: string, index: number): string | undefined;
  /**
   * How many visible letters of a node's text are before letter `letter`,
   * deleted or not. Undefined when the text has no such letter.
   */
  abstract indexOfLetter(node: string, letter: string): number | undefined;
  abstract insert(
    doc: Doc,
    node: string,
    index: number,
    text: string,
    attrs?: Record<string, Json>,
  ): void;
  abstract delete(doc: Doc, node: string, index: number, length: number): void;
  abstract format(
    doc: Doc,
    node: string,
    from: number,
    to: number,
    key: string,
    value: Json,
  ): void;
  /** Applies an edit operation: its inverse, or undefined if nothing changed. */
  abstract apply(doc: Doc, payload: EditOperation): EditOperation | undefined;
  /** What an undo or redo of the history applies. */
  abstract prepareUndo(doc: Doc, undo: EditOperation): EditOperation;
  abstract toJSON(): Json;
  abstract toStored(
    sessions: SessionTable,
    out: { encode(): string }[],
    root: string,
  ): StoredLetters | 0;
  /** The runs of each list, in order (a tombstone is a `-` per letter). */
  protected abstract _debugRuns(): string[][];
}

const asStore = (value: unknown): TextEngine => {
  if (!(value instanceof TextEngine)) throw new Error("Expected a text store");
  return value;
};

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
