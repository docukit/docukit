import type { Doc, DocNode } from "../main.js";
import type {
  InternalStateDefinition,
  Json,
  StateDefinition,
} from "../types.js";
import { withTransaction } from "../utils.js";
import {
  inheritRules,
  rulesOf,
  isHighSurrogate,
  type Rules,
  isLowSurrogate,
  sameValue,
  storeOf,
  type InheritRules,
  TEXT_KEY,
  type TextEngine,
  type TextSpan,
} from "./common.js";
import { useTextRows } from "./wire.js";

/** True when `index` falls between the two halves of a surrogate pair. */
const splitsPair = (text: string, index: number) =>
  isHighSurrogate(text.charCodeAt(index - 1)) &&
  isLowSurrogate(text.charCodeAt(index));

/** The handle returned by `node.state.<key>` for a `defineText` state. */
export class TextHandle {
  readonly #node: DocNode;
  readonly #rules: Rules | undefined;

  constructor(node: DocNode, rules: Rules | undefined) {
    this.#node = node;
    this.#rules = rules;
  }

  /** `setLetterState` of a range: `value: null` removes the key. */
  format(from: number, to: number, key: string, value: Json): void {
    withTransaction(this.#doc, () =>
      this.#store.format(this.#doc, this.#node.id, from, to, key, value),
    );
  }

  /**
   * `insertLetters`: `attrs` is the state of the new letters (`{}`: none).
   * Without it, they have what they inherit (see `defineText`).
   */
  insert(index: number, text: string, attrs?: Record<string, Json>): void {
    withTransaction(this.#doc, () =>
      this.#store.insert(this.#doc, this.#node.id, index, text, attrs),
    );
  }

  /** The visible length. */
  get length(): number {
    return this.#store.lengthOf(this.#node.id);
  }

  get #doc(): Doc {
    return this.#node.doc;
  }

  /** The visible text split into runs of identical attributes. */
  spans(): TextSpan[] {
    return this.#store.spansOf(this.#node.id);
  }

  /** The visible text. */
  get(): string {
    return this.#store.textOf(this.#node.id);
  }

  /**
   * Replaces the value with `text`, without state, keeping the common prefix
   * and suffix (see `applySpans`).
   */
  set(text: string, caret?: number): void {
    this.applySpans([{ text, attrs: {} }], caret);
  }

  /** Deletes `length` visible letters from `index`. */
  delete(index: number, length: number): void {
    withTransaction(this.#doc, () =>
      this.#store.delete(this.#doc, this.#node.id, index, length),
    );
  }

  /**
   * The id of the letter at visible `index`, undefined outside the text. A
   * letter keeps its id through every edit, so `indexOfLetter` finds the
   * place again after edits of other replicas: a cursor that stays put.
   */
  letterAt(index: number): string | undefined {
    return this.#store.letterAt(this.#node.id, index);
  }

  get #store(): TextEngine {
    const store = storeOf(this.#doc);
    store.setRules(this.#node.id, this.#rules);
    return store;
  }

  /**
   * The visible index of a letter `letterAt` gave: how many visible letters
   * are before it, so a deleted letter is where it was. Undefined when this
   * text has no such letter (yet).
   */
  indexOfLetter(letter: string): number | undefined {
    return this.#store.indexOfLetter(this.#node.id, letter);
  }

  /**
   * Brings the value to `target` with the smallest edit it can find. With
   * repeated text, several places give the same result (typing "a" in "aa"),
   * but only one keeps concurrent edits with the characters they were made
   * on. `caret`, where the edit ended in `target` (the cursor after typing,
   * pasting or deleting), picks that place.
   */
  applySpans(target: TextSpan[], caret?: number): void {
    withTransaction(this.#doc, () => {
      const next = target.map((span) => span.text).join("");
      const current = this.get();
      if (current !== next) this.#replaceDiff(current, next, caret, target);
      this.#applyFormatDiff(target);
    });
  }

  #applyFormatDiff(target: TextSpan[]): void {
    const current = this.spans();
    const stops = new Set([0]);
    for (const spans of [current, target]) {
      let cursor = 0;
      for (const span of spans) stops.add((cursor += span.text.length));
    }
    const positions = [...stops].sort((a, b) => a - b);
    const attrsAt = (spans: TextSpan[], index: number) => {
      let cursor = 0;
      for (const span of spans)
        if (index < (cursor += span.text.length)) return span.attrs;
      return {};
    };
    /** By key, the range a format waits to be written for, and its value. */
    const pending = new Map<string, [from: number, to: number, value: Json]>();
    const flush = (key: string) => {
      const range = pending.get(key);
      if (!range) return;
      pending.delete(key);
      this.format(range[0], range[1], key, range[2]);
    };
    for (let i = 0; i < positions.length - 1; i++) {
      const from = positions[i]!;
      const to = positions[i + 1]!;
      const was = attrsAt(current, from);
      const wants = attrsAt(target, from);
      const keys = new Set([...Object.keys(was), ...Object.keys(wants)]);
      for (const key of keys) {
        const after = wants[key] ?? null;
        const open = pending.get(key);
        if (sameValue(was[key] ?? null, after)) flush(key);
        else if (open?.[1] === from && sameValue(open[2], after)) open[1] = to;
        else {
          flush(key);
          pending.set(key, [from, to, after]);
        }
      }
      for (const key of [...pending.keys()]) if (!keys.has(key)) flush(key);
    }
    for (const key of [...pending.keys()]) flush(key);
  }

  #replaceDiff(
    current: string,
    next: string,
    caret: number | undefined,
    target: TextSpan[],
  ): void {
    const max = Math.min(current.length, next.length);
    let prefix = 0;
    while (
      prefix < max &&
      current.charCodeAt(prefix) === next.charCodeAt(prefix)
    )
      prefix++;
    if (prefix > 0 && isHighSurrogate(current.charCodeAt(prefix - 1))) prefix--;
    const commonSuffix = (limit: number) => {
      let suffix = 0;
      while (
        suffix < limit &&
        current.charCodeAt(current.length - 1 - suffix) ===
          next.charCodeAt(next.length - 1 - suffix)
      )
        suffix++;
      return suffix;
    };
    let suffix = commonSuffix(max - prefix);
    if (suffix > 0 && isLowSurrogate(next.charCodeAt(next.length - suffix)))
      suffix--;
    const grows = next.length > current.length;
    // A pure insert or delete in repeated text can slide left down to where the
    // common suffix ends; every place in between gives the same text.
    if (caret !== undefined && prefix + suffix === max) {
      const length = Math.abs(next.length - current.length);
      const at = Math.min(
        prefix,
        Math.max(max - commonSuffix(max), grows ? caret - length : caret),
      );
      if (
        !splitsPair(current, at) &&
        !splitsPair(grows ? next : current, at + length)
      ) {
        prefix = at;
        suffix = max - at;
      }
    }
    // Inserting first keeps the new text after the character at `prefix - 1`,
    // even when the deleted range starts right there.
    // New letters take their state from the target as they are inserted.
    const end = next.length - suffix;
    let at = prefix;
    let cursor = 0;
    for (const span of target) {
      const start = Math.max(cursor, prefix);
      const stop = Math.min(cursor + span.text.length, end);
      if (stop > start) {
        this.insert(
          at,
          span.text.slice(start - cursor, stop - cursor),
          span.attrs,
        );
        at += stop - start;
      }
      cursor += span.text.length;
    }
    if (current.length - suffix > prefix)
      this.delete(end, current.length - suffix - prefix);
  }
}

/**
 * The state of a `defineText` whose document root holds its text as `root`
 * says: Base's (`text/base.ts`) or that of the CRDT engine (`crdt/text.ts`).
 */
export function textDefinition(
  options: { inherit?: InheritRules; opaque?: string } | undefined,
  root: InternalStateDefinition,
): StateDefinition<number, Json, TextHandle> {
  const rules = rulesOf(options?.inherit, options?.opaque);
  useTextRows();
  const definition: InternalStateDefinition<number, Json, TextHandle> = {
    fromJSON: () => 0,
    docState: { key: TEXT_KEY, definition: root },
    methodsWithNode: (node) => new TextHandle(node, rules),
    onCopy: (from, to) => {
      const store = storeOf(from.doc);
      store.setRules(from.id, rules);
      store.setRules(to.id, rules);
      let cursor = 0;
      for (const span of store.spansOf(from.id)) {
        store.insert(from.doc, to.id, cursor, span.text, span.attrs);
        cursor += span.text.length;
      }
    },
  };
  if (rules) inheritRules.set(definition, rules);
  return definition;
}

/** @internal - Test helper. Do not use. */
export function _INTERNAL_textStore(doc: Doc): TextEngine {
  return storeOf(doc);
}
