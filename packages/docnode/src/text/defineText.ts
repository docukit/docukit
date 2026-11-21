import type { Doc, DocNode } from "../main.js";
import type {
  InternalStateDefinition,
  Json,
  StateDefinition,
} from "../types.js";
import { withTransaction } from "../utils.js";
import {
  isHighSurrogate,
  isLowSurrogate,
  storeOf,
  TEXT_KEY,
  type TextEngine,
  textState,
} from "./common.js";
import { BaseText } from "./baseText.js";

/** True when `index` falls between the two halves of a surrogate pair. */
const splitsPair = (text: string, index: number) =>
  isHighSurrogate(text.charCodeAt(index - 1)) &&
  isLowSurrogate(text.charCodeAt(index));

/** The handle returned by `node.state.<key>` for a `defineText` state. */
export class TextHandle {
  private readonly _node: DocNode;

  constructor(node: DocNode) {
    this._node = node;
  }

  private get _doc(): Doc {
    return this._node.doc;
  }

  private get _store(): TextEngine {
    return storeOf(this._doc);
  }

  /** The visible text. */
  get(): string {
    return this._store.textOf(this._node.id);
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

  /** `insertLetters`. */
  insert(index: number, text: string): void {
    withTransaction(this._doc, () =>
      this._store.insert(this._doc, this._node.id, index, text),
    );
  }

  /** Deletes `length` visible letters from `index`. */
  delete(index: number, length: number): void {
    withTransaction(this._doc, () =>
      this._store.delete(this._doc, this._node.id, index, length),
    );
  }

  /**
   * Replaces the value with `text`, keeping the common prefix and suffix:
   * the smallest edit it can find. With repeated text, several places give
   * the same result (typing "a" in "aa"), but only one keeps concurrent edits
   * with the characters they were made on. `caret`, where the edit ended in
   * `text` (the cursor after typing, pasting or deleting), picks that place.
   */
  set(text: string, caret?: number): void {
    withTransaction(this._doc, () => {
      const current = this.get();
      if (current !== text) this._replaceDiff(current, text, caret);
    });
  }

  private _replaceDiff(
    current: string,
    next: string,
    caret: number | undefined,
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
    this.insert(prefix, inserted);
    if (removed > 0) this.delete(prefix + inserted.length, removed);
  }
}

/** Base's text: a list per node in the server's order (see `BaseText`). */
const rootDefinition = textState(BaseText);

/**
 * Opt-in collaborative text: a list of letters per node. The server's order
 * places letters (see `BaseText`).
 */
export function defineText(): StateDefinition<number, Json, TextHandle> {
  const definition: InternalStateDefinition<number, Json, TextHandle> = {
    fromJSON: () => 0,
    docState: { key: TEXT_KEY, definition: rootDefinition },
    methodsWithNode: (_methods, node) => new TextHandle(node),
    onCopy: (from, to) => {
      const store = storeOf(from.doc);
      store.insert(from.doc, to.id, 0, store.textOf(from.id));
    },
  };
  return definition;
}

/** @internal - Test helper. Do not use. */
export function _INTERNAL_textStore(doc: Doc): TextEngine {
  return storeOf(doc);
}
