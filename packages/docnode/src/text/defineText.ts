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
  storeOf,
  type InheritRules,
  TEXT_KEY,
  type TextEngine,
  textState,
  type TextSpan,
} from "./common.js";
import { BaseText } from "./baseText.js";
import { useTextRows } from "./wire.js";

/** True when `index` falls between the two halves of a surrogate pair. */
const splitsPair = (text: string, index: number) =>
  isHighSurrogate(text.charCodeAt(index - 1)) &&
  isLowSurrogate(text.charCodeAt(index));

/** The handle returned by `node.state.<key>` for a `defineText` state. */
export class TextHandle {
  private readonly _node: DocNode;
  private readonly _rules: Rules | undefined;

  constructor(node: DocNode, rules: Rules | undefined) {
    this._node = node;
    this._rules = rules;
  }

  private get _doc(): Doc {
    return this._node.doc;
  }

  private get _store(): TextEngine {
    const store = storeOf(this._doc);
    store.setRules(this._node.id, this._rules);
    return store;
  }

  /** The visible text. */
  get(): string {
    return this._store.textOf(this._node.id);
  }

  /** The visible text split into runs of identical attributes. */
  spans(): TextSpan[] {
    return this._store.spansOf(this._node.id);
  }

  /** The visible length. */
  get length(): number {
    return this._store.lengthOf(this._node.id);
  }

  /**
   * The id of the letter at visible `index`, undefined outside the text. A
   * letter keeps its id through every edit, so `indexOfLetter` finds the
   * place again after edits of other replicas: a cursor that stays put.
   */
  letterAt(index: number): string | undefined {
    return this._store.letterAt(this._node.id, index);
  }

  /**
   * The visible index of a letter `letterAt` gave: how many visible letters
   * are before it, so a deleted letter is where it was. Undefined when this
   * text has no such letter (yet).
   */
  indexOfLetter(letter: string): number | undefined {
    return this._store.indexOfLetter(this._node.id, letter);
  }

  /**
   * `insertLetters`: `attrs` is the state of the new letters (`{}`: none).
   * Without it, they have what they inherit (see `defineText`).
   */
  insert(index: number, text: string, attrs?: Record<string, Json>): void {
    withTransaction(this._doc, () =>
      this._store.insert(this._doc, this._node.id, index, text, attrs),
    );
  }

  /** Deletes `length` visible letters from `index`. */
  delete(index: number, length: number): void {
    withTransaction(this._doc, () =>
      this._store.delete(this._doc, this._node.id, index, length),
    );
  }

  /** `setLetterState` of a range: `value: null` removes the key. */
  format(from: number, to: number, key: string, value: Json): void {
    withTransaction(this._doc, () =>
      this._store.format(this._doc, this._node.id, from, to, key, value),
    );
  }

  /**
   * Replaces the value with `text`, without state, keeping the common prefix
   * and suffix (see `applySpans`).
   */
  set(text: string, caret?: number): void {
    this.applySpans([{ text, attrs: {} }], caret);
  }

  /**
   * Brings the value to `target` with the smallest edit it can find. With
   * repeated text, several places give the same result (typing "a" in "aa"),
   * but only one keeps concurrent edits with the characters they were made
   * on. `caret`, where the edit ended in `target` (the cursor after typing,
   * pasting or deleting), picks that place.
   */
  applySpans(target: TextSpan[], caret?: number): void {
    withTransaction(this._doc, () => {
      const next = target.map((span) => span.text).join("");
      const current = this.get();
      if (current !== next) this._replaceDiff(current, next, caret, target);
      this._applyFormatDiff(target);
    });
  }

  private _replaceDiff(
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
    // A pure insert or delete in repeated text can slide left down to where the
    // common suffix ends; every place in between gives the same text.
    if (caret !== undefined && prefix + suffix === max) {
      const length = Math.abs(next.length - current.length);
      const lowest = max - commonSuffix(max);
      const wanted = next.length > current.length ? caret - length : caret;
      const at = Math.min(prefix, Math.max(lowest, wanted));
      const longer = next.length > current.length ? next : current;
      if (!splitsPair(current, at) && !splitsPair(longer, at + length)) {
        prefix = at;
        suffix = max - at;
      }
    }
    const removed = current.length - prefix - suffix;
    const inserted = next.slice(prefix, next.length - suffix);
    // Inserting first keeps the new text after the character at `prefix - 1`,
    // even when the deleted range starts right there.
    // New letters take their state from the target as they are inserted.
    let at = prefix;
    for (const piece of slicesOf(target, prefix, prefix + inserted.length)) {
      this.insert(at, piece.text, piece.attrs ?? {});
      at += piece.text.length;
    }
    if (removed > 0) this.delete(prefix + inserted.length, removed);
  }

  private _applyFormatDiff(target: TextSpan[]): void {
    const current = this.spans();
    const stops = new Set<number>([0]);
    const collect = (spans: TextSpan[]) => {
      let cursor = 0;
      for (const span of spans) {
        cursor += span.text.length;
        stops.add(cursor);
      }
    };
    collect(current);
    collect(target);
    const positions = [...stops].sort((a, b) => a - b);
    const attrsAt = (spans: TextSpan[], index: number) => {
      let cursor = 0;
      for (const span of spans) {
        cursor += span.text.length;
        if (index < cursor) return span.attrs;
      }
      return {};
    };
    type Pending = { from: number; to: number; value: Json };
    const pending = new Map<string, Pending>();
    const flush = (key: string) => {
      const range = pending.get(key);
      if (!range) return;
      pending.delete(key);
      this.format(range.from, range.to, key, range.value);
    };
    for (let i = 0; i < positions.length - 1; i++) {
      const from = positions[i]!;
      const to = positions[i + 1]!;
      const was = attrsAt(current, from);
      const wants = attrsAt(target, from);
      const keys = new Set([...Object.keys(was), ...Object.keys(wants)]);
      for (const key of keys) {
        const before = was[key] ?? null;
        const after = wants[key] ?? null;
        if (JSON.stringify(before) === JSON.stringify(after)) {
          flush(key);
          continue;
        }
        const open = pending.get(key);
        if (
          open?.to === from &&
          JSON.stringify(open.value) === JSON.stringify(after)
        ) {
          open.to = to;
        } else {
          flush(key);
          pending.set(key, { from, to, value: after });
        }
      }
      for (const key of [...pending.keys()]) {
        if (!keys.has(key)) flush(key);
      }
    }
    for (const key of [...pending.keys()]) flush(key);
  }
}

/** The pieces of `spans` between two indexes of their text. */
function slicesOf(spans: TextSpan[], from: number, to: number) {
  const out: { text: string; attrs: Record<string, Json> | undefined }[] = [];
  let cursor = 0;
  for (const span of spans) {
    const end = cursor + span.text.length;
    const start = Math.max(cursor, from);
    const stop = Math.min(end, to);
    if (stop > start) {
      const empty = Object.keys(span.attrs).length === 0;
      out.push({
        text: span.text.slice(start - cursor, stop - cursor),
        attrs: empty ? undefined : span.attrs,
      });
    }
    cursor = end;
  }
  return out;
}

/**
 * Base's text: a list per node in the server's order (see `BaseText`). Made
 * by the first `defineText`: an app without text does not bundle it.
 */
let rootDefinition: InternalStateDefinition | undefined;

/**
 * Opt-in collaborative text: a list of letters per node, and a state per
 * letter and key where the last write wins. In Base the server's order
 * places letters (see `BaseText`); with a CRDT engine, FugueMax does.
 * `inherit`: the keys a letter without a value of its own reads from the
 * letters it was typed between (see `Inherit`), like
 * `{ bold: "origin", link: "both", "comment:*": "both" }`. `opaque`: the
 * characters whose letters inherit nothing, like one that ends a paragraph.
 */
export function defineText(options?: {
  inherit?: InheritRules;
  opaque?: string;
}): StateDefinition<number, Json, TextHandle> {
  const inherit = options?.inherit;
  const rules =
    inherit && Object.keys(inherit).length > 0
      ? rulesOf(inherit, options?.opaque)
      : undefined;
  useTextRows();
  rootDefinition ??= textState(BaseText);
  const definition: InternalStateDefinition<number, Json, TextHandle> = {
    fromJSON: () => 0,
    docState: { key: TEXT_KEY, definition: rootDefinition },
    methodsWithNode: (_methods, node) => new TextHandle(node, rules),
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
