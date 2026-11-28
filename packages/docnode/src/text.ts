import type { Doc, DocNode } from "./main.js";
import type { MoveOperation, TextOperation } from "./operations.js";
import type { StateDefinition, TextEngine } from "./types.js";
import { MAX_CLOCK, numberToBase64 } from "./idGenerator.js";
import { textEngines, withTransaction } from "./utils.js";

// `text()`: a string whose letters have ids, so that an edit of one replica
// lands in the same place on the others. The server orders the edits (Base
// mode): there are no tombstones, and a letter that is deleted is gone.
//
// - A letter's id is `session.clock`, like a node's: nodes and letters take
//   the clock of the document's session (`NodeIds.take`).
// - A text keeps its letters as runs (`Run`): letters of one session with
//   consecutive clocks, so only the first id of a run is kept (as Yjs's
//   `ContentString` and Loro's `TextChunk`), and a saved cursor to go from an
//   index to a run, since edits are usually near the one before.
// - The id of a letter leads to its run through `Letters`, the runs of each
//   session sorted by clock (as Yjs's `findIndexSS`). It is built the first
//   time an operation names a letter by its id: a replica that only types
//   never builds it.
// - Operations: see `TextOperation` and `wire.ts`. Deleting letters is
//   `[1, first, last]`, like deleting nodes: an id is of a node or of a
//   letter, never both. An undo puts letters back with their own ids.
// - Moving letters (`moveTo`, for Enter and for Backspace at the start of a
//   paragraph) is a row 2 over them, like moving nodes: the letters keep
//   their ids, so the edits of other replicas follow them. Its undo is a
//   move back. Like Loro's `MovableList`, a letter's id does not change when
//   it moves; without concurrent moves to settle (the server orders them),
//   no other place is kept for it.
// - A stored document keeps a text as its string, in `values`, and the id
//   runs of its letters in the `letters` column (see `engine.lettersWriter`).

/** A change of a text in a transaction, in the order they were applied. */
type TextChange = { index: number; deleted: number; inserted: string };

/** A change as the transaction keeps it, with the letters it deleted. */
export type Splice = [index: number, deleted: string, inserted: string];

/**
 * A text: a string whose letters have ids. Each node and key gets its own
 * text the first time it is edited (see `stateOf`).
 */
export function text(): StateDefinition<string, string, TextMethods> {
  const definition: StateDefinition<string, string, TextMethods> = {
    // A stored document keeps a text as its string, and the ids of its
    // letters in another column (see `engine.lettersReader`).
    fromJSON: (json) => (typeof json === "string" ? json : ""),
    toJSON: (value: string | TextState) =>
      typeof value === "string" ? value : textOf(value),
  };
  textEngines.set(definition, engine);
  return definition;
}

/** Letters of one session with consecutive clocks, the first at `c`. */
class Run {
  /** The index of its session in the document's `NodeIds`. */
  s: number;
  c: number;
  text: string;
  readonly owner: TextState;

  constructor(s: number, c: number, text: string, owner: TextState) {
    this.s = s;
    this.c = c;
    this.text = text;
    this.owner = owner;
  }
}

/** The text of a node's key: its runs in order. */
class TextState {
  readonly node: DocNode;
  readonly key: string;
  readonly runs: Run[] = [];
  length = 0;
  /** The saved cursor: the run `at` and the letters before it. */
  at = 0;
  before = 0;
  /** The text, until it changes. */
  cached: string | undefined = "";

  constructor(node: DocNode, key: string) {
    this.node = node;
    this.key = key;
  }
}

/**
 * The runs of the document's texts by session, each sorted by clock, to find
 * the letter of an id (like Yjs's `findIndexSS`). It has the texts of the
 * nodes in the document only.
 */
export class Letters {
  private readonly _sessions = new Map<number, Run[]>();
  /** The run `find` found last. */
  private _last: Run | undefined;

  /** Adds a run whose letters are not here yet. */
  add(run: Run) {
    let runs = this._sessions.get(run.s);
    if (!runs) this._sessions.set(run.s, (runs = []));
    // A run of a new letter comes after the others of its session.
    if (runs.length === 0 || runs[runs.length - 1]!.c < run.c) runs.push(run);
    else runs.splice(lowerBound(runs, run.c), 0, run);
  }

  remove(run: Run) {
    const runs = this._sessions.get(run.s)!;
    runs.splice(lowerBound(runs, run.c), 1);
    if (this._last === run) this._last = undefined;
  }

  /** The run that has the letter at clock `c` of session `s`. */
  find(s: number, c: number) {
    const last = this._last;
    if (last?.s === s && c >= last.c && c < last.c + last.text.length)
      return last;
    const runs = this._sessions.get(s);
    if (!runs) return undefined;
    let low = 0;
    let high = runs.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (runs[mid]!.c <= c) low = mid;
      else high = mid - 1;
    }
    const run = runs[low];
    if (!run || c < run.c || c >= run.c + run.text.length) return undefined;
    this._last = run;
    return run;
  }

  /** The letters of the texts of `doc`'s nodes. */
  static of(doc: Doc) {
    const letters = new Letters();
    const sessions = letters._sessions;
    for (const node of doc["_nodeMap"].values()) {
      const keys = doc["_resolvedNodeDefs"].get(node.type)!.textKeys;
      if (!keys) continue;
      for (const key of keys) {
        const state = valueAt(node, key);
        if (!(state instanceof TextState)) continue;
        for (const run of state.runs) {
          let runs = sessions.get(run.s);
          if (!runs) sessions.set(run.s, (runs = []));
          runs.push(run);
        }
      }
    }
    for (const runs of sessions.values()) runs.sort((a, b) => a.c - b.c);
    return letters;
  }
}

/** The first index of `runs` whose clock is `c` or more. */
function lowerBound(runs: Run[], c: number) {
  let low = 0;
  let high = runs.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (runs[mid]!.c < c) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The letters of `doc`, which it builds the first time (see `Letters`). */
const lettersOf = (doc: Doc) => (doc["_letters"] ??= Letters.of(doc));

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The string of a text. */
function textOf(state: TextState) {
  if (state.cached !== undefined) return state.cached;
  let text = "";
  for (const run of state.runs) text += run.text;
  return (state.cached = text);
}

/** The state value of the node's key. */
function valueAt(node: DocNode, key: string) {
  const state: Record<string, unknown> = node["_state"];
  return state[key];
}

/** Whether the node is in its document. */
function isAttached(node: DocNode) {
  const id = node["_id"];
  return id !== undefined && node.doc["_nodeMap"].get(id) === node;
}

/**
 * The text of the node's key, which must be in the document or being
 * inserted. A text that was never edited there is a string (the default, the
 * string of a copy, or one edited before the node was inserted): it becomes a
 * `TextState` here, its letters taking new ids of the document's session.
 * The document does not have those letters yet: `engine.attach` adds them.
 */
function stateOf(node: DocNode, key: string) {
  const value = valueAt(node, key);
  if (value instanceof TextState) return value;
  const state = new TextState(node, key);
  if (typeof value === "string" && value !== "") {
    const ids = node.doc["_nodeIds"]!;
    const run = new Run(ids["_index"], ids.take(value.length), value, state);
    state.runs.push(run);
    state.length = value.length;
    state.cached = value;
  }
  node["_values"]()[key] = state;
  return state;
}

/** The run with the letter at `index` of the text, which it sets as cursor. */
function seek(state: TextState, index: number) {
  const runs = state.runs;
  let at = state.at;
  let before = state.before;
  while (index < before) before -= runs[--at]!.text.length;
  while (index >= before + runs[at]!.text.length)
    before += runs[at++]!.text.length;
  state.at = at;
  state.before = before;
  return at;
}

/** How many letters of the text are before `run`, which it sets as cursor. */
function startOf(state: TextState, run: Run) {
  const runs = state.runs;
  const index = runs.indexOf(run);
  let at = state.at;
  let before = state.before;
  while (at < index) before += runs[at++]!.text.length;
  while (at > index) before -= runs[--at]!.text.length;
  state.at = at;
  state.before = before;
  return before;
}

/** The id of the letter `offset` of a run. */
const idOf = (doc: Doc, run: Run, offset: number) =>
  `${doc["_nodeIds"]!.session(run.s)}.${numberToBase64(run.c + offset)}`;

/** The id of the letter at `index` of the text. */
function letterAt(state: TextState, index: number) {
  const run = state.runs[seek(state, index)]!;
  return idOf(state.node.doc, run, index - state.before);
}

/** The letter of `id` in a text of the document: its run and offset. */
function find(doc: Doc, id: string) {
  const ids = doc["_nodeIds"]!;
  const session = ids.split(id);
  if (session < 0) return undefined;
  const clock = ids.splitClock;
  const run = lettersOf(doc).find(session, clock);
  return run && { run, offset: clock - run.c };
}

/** The index of the letter of `id` in its text, if it is in the document. */
function indexOf(doc: Doc, id: string) {
  const letter = find(doc, id);
  if (!letter) return undefined;
  const { run, offset } = letter;
  return { state: run.owner, index: startOf(run.owner, run) + offset };
}

/** Cuts the run at `at` in two: the second part starts at letter `offset`. */
function split(state: TextState, at: number, offset: number) {
  const run = state.runs[at]!;
  const right = new Run(run.s, run.c + offset, run.text.slice(offset), state);
  run.text = run.text.slice(0, offset);
  state.runs.splice(at + 1, 0, right);
  state.node.doc["_letters"]?.add(right);
}

/** Puts `text`, letters of session `s` from clock `c`, at `index`. */
function place(
  state: TextState,
  index: number,
  text: string,
  s: number,
  c: number,
) {
  const runs = state.runs;
  let run: Run | undefined = new Run(s, c, text, state);
  if (index === 0) {
    runs.unshift(run);
    state.at = 0;
    state.before = 0;
  } else {
    const at = seek(state, index - 1);
    const left = runs[at]!;
    const offset = index - state.before;
    if (offset < left.text.length) {
      split(state, at, offset);
      runs.splice(at + 1, 0, run);
    } else if (left.s === s && left.c + offset === c) {
      // Typing after the letter typed before, the most common edit.
      left.text += text;
      run = undefined;
    } else runs.splice(at + 1, 0, run);
  }
  if (run) state.node.doc["_letters"]?.add(run);
  state.length += text.length;
  state.cached = undefined;
}

/**
 * Takes `length` letters from `index` out of the text. Returns them as runs,
 * in order, the ones that follow in clock joined.
 */
function cut(state: TextState, index: number, length: number) {
  const runs = state.runs;
  const letters = state.node.doc["_letters"];
  let at = seek(state, index);
  const offset = index - state.before;
  if (offset > 0) split(state, at++, offset);
  const taken: Run[] = [];
  let end = at;
  for (let left = length; left > 0; end++) {
    const run = runs[end]!;
    if (run.text.length > left) split(state, end, left);
    left -= run.text.length;
    letters?.remove(run);
    const last = taken[taken.length - 1];
    if (last?.s === run.s && last.c + last.text.length === run.c)
      last.text += run.text;
    else taken.push(run);
  }
  runs.splice(at, end - at);
  state.length -= length;
  state.cached = undefined;
  // The cursor: the run before the letters taken, which ends at `index`.
  state.at = at > 0 ? at - 1 : 0;
  state.before = at > 0 ? index - runs[at - 1]!.text.length : 0;
  return taken;
}

/**
 * The node of a text as an insert of letters into an empty text names it:
 * `0` for the root, else its id, which must be `session.clock` so that a
 * batch can write it (see `wire.ts`).
 */
function nodeRef(node: DocNode) {
  if (node === node.doc.root) return 0;
  if (node["_session"] < 0)
    throw new Error(
      `The text of node '${node.id}' cannot be written: its id is not of the form session.clock.`,
    );
  return node.id;
}

/**
 * The inserts that put `runs` back with their ids, in order: the first
 * between `prev` and `next` (or into the empty text of the node's key), each
 * other one after the one before.
 */
function insertsOf(
  state: TextState,
  runs: readonly Run[],
  prev: string | 0,
  next: string | 0,
) {
  const doc = state.node.doc;
  const inserts: TextOperation[] = [];
  for (const run of runs) {
    const first = idOf(doc, run, 0);
    if (prev === 0 && next === 0)
      inserts.push([4, first, 0, 0, run.text, nodeRef(state.node), state.key]);
    else inserts.push([4, first, prev, next, run.text]);
    prev = idOf(doc, run, run.text.length - 1);
  }
  return inserts;
}

/** Keeps a change of the text for `changes` and `getPrev`. */
function addChange(state: TextState, splice: Splice) {
  const doc = state.node.doc;
  let byNode = doc["_textChanges"];
  if (!byNode) doc["_textChanges"] = byNode = new Map();
  let byKey = byNode.get(state.node);
  if (!byKey) {
    byKey = new Map();
    byNode.set(state.node, byKey);
  }
  const splices = byKey.get(state.key);
  if (splices) splices.push(splice);
  else byKey.set(state.key, [splice]);
}

/**
 * Inserts `text` at `index`, its letters of session `s` from clock `c`, and
 * records the insert, its inverse and the change.
 */
function insertLetters(
  state: TextState,
  index: number,
  text: string,
  s: number,
  c: number,
) {
  const node = state.node;
  const doc = node.doc;
  const run = new Run(s, c, text, state);
  const first = idOf(doc, run, 0);
  if (state.length === 0)
    doc["_operations"][0].push([
      4,
      first,
      0,
      0,
      text,
      nodeRef(node),
      state.key,
    ]);
  else
    doc["_operations"][0].push([
      4,
      first,
      index > 0 ? letterAt(state, index - 1) : 0,
      index < state.length ? letterAt(state, index) : 0,
      text,
    ]);
  if (!doc["_diff"].inserted.has(node.id)) {
    const last = text.length > 1 ? idOf(doc, run, text.length - 1) : 0;
    const inverse = doc["_inverseOperations"][0];
    const before = inverse[inverse.length - 1];
    // Right after the letters the delete before deletes (an undo that puts
    // back a long delete, or typing): one delete for them all.
    if (
      before?.[0] === 1 &&
      index > 0 &&
      (before[2] || before[1]) === letterAt(state, index - 1)
    )
      inverse[inverse.length - 1] = [1, before[1], last || first];
    else inverse.push([1, first, last]);
    doc["_diff"].updated.add(node.id);
  }
  addChange(state, [index, "", text]);
  place(state, index, text, s, c);
}

/**
 * Deletes `length` letters from `index`, and records the delete, its inverse
 * (inserts that put the letters back with their ids) and the change.
 */
function deleteLetters(state: TextState, index: number, length: number) {
  const node = state.node;
  const doc = node.doc;
  const prev = index > 0 ? letterAt(state, index - 1) : 0;
  const next =
    index + length < state.length ? letterAt(state, index + length) : 0;
  const first = letterAt(state, index);
  const last = length > 1 ? letterAt(state, index + length - 1) : 0;
  doc["_operations"][0].push([1, first, last]);
  const taken = cut(state, index, length);
  let deleted = "";
  for (const run of taken) deleted += run.text;
  if (!doc["_diff"].inserted.has(node.id)) {
    // Reversed with the rest of the inverse when the transaction commits.
    const inserts = insertsOf(state, taken, prev, next);
    for (let i = inserts.length - 1; i >= 0; i--)
      doc["_inverseOperations"][0].push(inserts[i]!);
    doc["_diff"].updated.add(node.id);
  }
  addChange(state, [index, deleted, ""]);
}

const outOfRange = (what: string, index: number, length: number) =>
  new RangeError(
    `The ${what} ${index} is out of the range of a text of length ${length}.`,
  );
const splitPair = (what: string, index: number) =>
  new RangeError(
    `The ${what} ${index} splits a surrogate pair: a letter written with two code units.`,
  );

/** Throws unless `length` letters from `index` are letters of the text. */
function checkRange(
  state: TextState,
  index: number,
  length: number,
  what: "delete" | "move",
) {
  checkIndex(state, index, "index");
  checkLength(length, what);
  checkIndex(state, index + length, "end");
}

/** Throws unless `index` is a place of the text that splits no letter pair. */
function checkIndex(state: TextState, index: number, what: string) {
  if (!Number.isInteger(index) || index < 0 || index > state.length)
    throw outOfRange(what, index, state.length);
  if (index === 0 || index === state.length) return;
  const run = state.runs[seek(state, index - 1)]!;
  const offset = index - 1 - state.before;
  const high = run.text.charCodeAt(offset);
  const low =
    offset + 1 < run.text.length
      ? run.text.charCodeAt(offset + 1)
      : state.runs[state.at + 1]!.text.charCodeAt(0);
  if (isHighSurrogate(high) && isLowSurrogate(low))
    throw splitPair(what, index);
}

/** `checkIndex` for the string of a text. */
function checkPlace(text: string, index: number, what: string) {
  if (!Number.isInteger(index) || index < 0 || index > text.length)
    throw outOfRange(what, index, text.length);
  if (splitsPair(text, index)) throw splitPair(what, index);
}

/** Throws unless `length` letters can be deleted or moved. */
function checkLength(length: number, what: "delete" | "move") {
  if (!Number.isInteger(length) || length < 0)
    throw new RangeError(`Cannot ${what} ${length} letters.`);
}

/**
 * Replaces `length` letters from `index` with `text` in the text of a node
 * that is not in the document. It stays a string: its letters take their ids
 * when the node is inserted (see `attach`), after the ids of the nodes.
 */
function editLoose(
  node: DocNode,
  key: string,
  index: number,
  length: number,
  text: string,
) {
  const value = valueOf(node, key);
  checkPlace(value, index, "index");
  checkLength(length, "delete");
  checkPlace(value, index + length, "end");
  withTransaction(node.doc, () => {
    node["_values"]()[key] =
      value.slice(0, index) + text + value.slice(index + length);
  });
}

/** Inserts `text` at `index` with new ids of the document's session. */
function insertNew(state: TextState, index: number, text: string) {
  if (text === "") return;
  const ids = state.node.doc["_nodeIds"]!;
  const s = ids["_index"];
  insertLetters(state, index, text, s, ids.take(text.length));
}

/**
 * Replaces the text with `next` (see `TextMethods.set`). Ported from the
 * closed #113 (`defineText.ts`, `_replaceDiff`).
 */
function replace(state: TextState, next: string, caret: number | undefined) {
  const current = textOf(state);
  const max = Math.min(current.length, next.length);
  let prefix = 0;
  while (prefix < max && current.charCodeAt(prefix) === next.charCodeAt(prefix))
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
  // A pure insert or delete in repeated letters can slide left down to where
  // the common suffix ends: every place in between gives the same text.
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
  // Inserting first keeps the new letters after the one at `prefix - 1`,
  // even when the deleted ones start right there.
  insertNew(state, prefix, inserted);
  if (removed > 0) deleteLetters(state, prefix + inserted.length, removed);
}

/** Whether `index` falls between the two halves of a surrogate pair. */
const splitsPair = (text: string, index: number) =>
  isHighSurrogate(text.charCodeAt(index - 1)) &&
  isLowSurrogate(text.charCodeAt(index));

const getPrevError = [
  "getPrev cannot be used on nodes that are not attached or that",
  "have been inserted in the current transaction. Usually, you",
  "will want to use getPrev with nodes from diff.updated.",
].join(" ");

/** The changes of the node's key in this transaction. */
const splicesOf = (node: DocNode, key: string): readonly Splice[] =>
  node.doc["_textChanges"]?.get(node)?.get(key) ?? [];

/**
 * The string of a text that may not be a `TextState` yet: one never edited
 * of a node in a document is empty (see `stateOf`), and one of a node not
 * inserted yet is a string (see `editLoose`).
 */
function valueOf(node: DocNode, key: string) {
  const value = valueAt(node, key);
  if (value instanceof TextState) return textOf(value);
  return typeof value === "string" ? value : "";
}

/** The error of a `letters` column that does not fit its texts. */
const invalidLetters = (what: string) =>
  new Error(`Invalid stored document: ${what}.`);

/**
 * The letters from `first` to `last` (`0`: `first` only), if both are in one
 * text of the document, in that order.
 */
function rangeOf(doc: Doc, first: string, last: string | 0) {
  const from = indexOf(doc, first);
  if (!from) return undefined;
  const to = last === 0 ? from : indexOf(doc, last);
  if (to?.state !== from.state || to.index < from.index) return undefined;
  return {
    state: from.state,
    index: from.index,
    length: to.index - from.index + 1,
  };
}

/**
 * Where an insert or a move puts letters (see `TextOperation`): with `key`,
 * the start of that text of the node (`0` for the root), if the node is in
 * the document; else right after `prev`, or if it is gone right before
 * `next`. If none of them is, nowhere.
 */
function targetOf(
  doc: Doc,
  nodeId: string | 0 | undefined,
  prev: string | 0,
  next: string | 0,
  key: string | undefined,
) {
  if (key !== undefined) {
    const node = nodeId ? doc.getNodeById(nodeId) : doc.root;
    const keys = node && doc["_resolvedNodeDefs"].get(node.type)!.textKeys;
    if (!keys?.includes(key)) return undefined;
    // The text has letters already: the new ones go first.
    return { state: stateOf(node!, key), index: 0 };
  }
  const after = prev === 0 ? undefined : indexOf(doc, prev);
  if (after) return { state: after.state, index: after.index + 1 };
  return next === 0 ? undefined : indexOf(doc, next);
}

/**
 * The move of the letters from `first` to `last` between `prev` and `next`
 * of the text, or into it if both are `0`: it is empty.
 */
const moveOf = (
  state: TextState,
  first: string,
  last: string | 0,
  prev: string | 0,
  next: string | 0,
): MoveOperation =>
  prev === 0 && next === 0
    ? [2, first, last, nodeRef(state.node), 0, 0, state.key]
    : [2, first, last, 0, prev, next];

/**
 * Moves `length` letters from `index` of `source` to `target`, where they
 * start at `to` after the move, with their ids. Both nodes are in the
 * document: it records the move, its inverse (a move back) and the changes
 * of both texts.
 */
function moveLetters(
  source: TextState,
  index: number,
  length: number,
  target: TextState,
  to: number,
) {
  const doc = source.node.doc;
  const first = letterAt(source, index);
  const last = length > 1 ? letterAt(source, index + length - 1) : 0;
  // Where they go in the target as it is now, with them.
  const at = source === target && to > index ? to + length : to;
  doc["_operations"][0].push(
    moveOf(
      target,
      first,
      last,
      at > 0 ? letterAt(target, at - 1) : 0,
      at < target.length ? letterAt(target, at) : 0,
    ),
  );
  const inserted = doc["_diff"].inserted;
  const sourceIsNew = inserted.has(source.node.id);
  const targetIsNew = inserted.has(target.node.id);
  // If both nodes are new, the inverse deletes them.
  if (!sourceIsNew || !targetIsNew)
    doc["_inverseOperations"][0].push(
      moveOf(
        source,
        first,
        last,
        index > 0 ? letterAt(source, index - 1) : 0,
        index + length < source.length ? letterAt(source, index + length) : 0,
      ),
    );
  if (!sourceIsNew) doc["_diff"].updated.add(source.node.id);
  if (!targetIsNew) doc["_diff"].updated.add(target.node.id);
  let moved = "";
  for (const run of cut(source, index, length)) {
    place(target, to + moved.length, run.text, run.s, run.c);
    moved += run.text;
  }
  addChange(source, [index, moved, ""]);
  addChange(target, [to, "", moved]);
}

/**
 * What `node.state[key]` gives for a `text()` key. Exported as a type: it
 * names the type of a text in declarations, and `moveTo` takes only a text.
 */
export class TextMethods {
  protected readonly _node: DocNode;
  protected readonly _key: string;

  constructor(node: DocNode, key: string) {
    this._node = node;
    this._key = key;
  }

  /** The text. */
  readonly get = () => valueOf(this._node, this._key);

  /**
   * The text at the start of the transaction, rebuilt from `changes`, and
   * whether it differs. Like `getPrev` of other states, only for nodes in
   * `diff.updated`.
   */
  readonly getPrev = (): [changed: boolean, value: string] => {
    const node = this._node;
    const id = node["_id"];
    if (id === undefined || !node.doc["_diff"].updated.has(id))
      throw new Error(getPrevError);
    const current = valueOf(node, this._key);
    let prev = current;
    const splices = splicesOf(node, this._key);
    for (let i = splices.length - 1; i >= 0; i--) {
      const [index, deleted, inserted] = splices[i]!;
      prev =
        prev.slice(0, index) + deleted + prev.slice(index + inserted.length);
    }
    return [prev !== current, prev];
  };

  /**
   * Replaces the text with `value`, keeping the common prefix and suffix:
   * the smallest edit. With repeated letters, several places give the same
   * text (typing "a" in "aa"); `caret`, where the edit ended in the new text
   * (the cursor after typing, pasting or deleting), picks that place, so
   * that concurrent edits stay with the letters they were made on.
   */
  readonly set = (
    value: string | ((prev: string) => string),
    caret?: number,
  ) => {
    const { _node: node, _key: key } = this;
    withTransaction(node.doc, () => {
      if (!isAttached(node)) {
        const current = valueOf(node, key);
        const next = typeof value === "function" ? value(current) : value;
        if (next !== current) node["_values"]()[key] = next;
        return;
      }
      const state = stateOf(node, key);
      const next = typeof value === "function" ? value(textOf(state)) : value;
      if (next !== textOf(state)) replace(state, next, caret);
    });
  };

  /** Inserts `text` at `index` (in UTF-16 code units, like `string.length`). */
  readonly insert = (index: number, text: string) => {
    const { _node: node, _key: key } = this;
    if (!isAttached(node)) return editLoose(node, key, index, 0, text);
    checkIndex(stateOf(node, key), index, "index");
    withTransaction(node.doc, () => insertNew(stateOf(node, key), index, text));
  };

  /** Deletes `length` letters from `index`. */
  readonly delete = (index: number, length: number) => {
    const { _node: node, _key: key } = this;
    if (!isAttached(node)) return editLoose(node, key, index, length, "");
    checkRange(stateOf(node, key), index, length, "delete");
    withTransaction(node.doc, () => {
      if (length > 0) deleteLetters(stateOf(node, key), index, length);
    });
  };

  /**
   * Moves `length` letters from `index` to `target`, a text of a node of the
   * same document (or this text), where they start at `targetIndex` after
   * the move, as in Loro's `MovableList.move`. The letters keep their ids,
   * so what other replicas do to them follows them. Enter moves the letters
   * after the caret into the empty text of a new paragraph; Backspace at the
   * start of a paragraph moves all of its letters to the end of the one
   * before. Both nodes must be in the document.
   */
  readonly moveTo = (
    index: number,
    length: number,
    target: TextMethods,
    targetIndex: number,
  ) => {
    const { _node: node, _key: key } = this;
    const { _node: targetNode, _key: targetKey } = target;
    if (
      targetNode.doc !== node.doc ||
      !isAttached(node) ||
      !isAttached(targetNode)
    )
      throw new Error(
        "Letters can only be moved between texts of nodes in the same document.",
      );
    const source = stateOf(node, key);
    checkRange(source, index, length, "move");
    const state = stateOf(targetNode, targetKey);
    // In this text, `targetIndex` is after the letters leave.
    const at =
      state === source && targetIndex > index
        ? targetIndex + length
        : targetIndex;
    checkIndex(state, at, "target index");
    if (length === 0 || (state === source && targetIndex === index)) return;
    withTransaction(node.doc, () =>
      moveLetters(
        stateOf(node, key),
        index,
        length,
        stateOf(targetNode, targetKey),
        targetIndex,
      ),
    );
  };

  /** The changes of this transaction (local, remote or undo), in order. */
  readonly changes = (): readonly TextChange[] =>
    splicesOf(this._node, this._key).map(([index, deleted, inserted]) => ({
      index,
      deleted: deleted.length,
      inserted,
    }));

  /** The length of the text. */
  get length() {
    const value = valueAt(this._node, this._key);
    if (value instanceof TextState) return value.length;
    return typeof value === "string" ? value.length : 0;
  }
}

/** What `doc` asks of texts (see `TextEngine`). */
const engine: TextEngine = {
  methods: (node, key) => new TextMethods(node, key),

  attach: (node, keys, ordered) => {
    // A node loaded in the document has its letters there already (see
    // `stateOf`); one being inserted is not in it yet.
    const letters = isAttached(node) ? undefined : node.doc["_letters"];
    for (const key of keys) {
      const value = valueAt(node, key);
      if (value === undefined || value === "") continue;
      const state = stateOf(node, key);
      if (letters) for (const run of state.runs) letters.add(run);
      ordered.push(...insertsOf(state, state.runs, 0, 0));
    }
  },

  detach: (node, keys, inverse) => {
    const letters = node.doc["_letters"];
    for (const key of keys) {
      const value = valueAt(node, key);
      if (value === undefined || value === "") continue;
      const state = stateOf(node, key);
      if (letters) for (const run of state.runs) letters.remove(run);
      if (inverse) inverse.push(...insertsOf(state, state.runs, 0, 0));
    }
  },

  insert: (doc, operation) => {
    const [, first, prev, next, text, nodeId, key] = operation;
    const ids = doc["_nodeIds"]!;
    const s = ids.split(first);
    const c = ids.splitClock;
    // Letters that are here already are left as they are, like a node.
    if (lettersOf(doc).find(s, c)) return;
    const target = targetOf(doc, nodeId, prev, next, key);
    if (!target) return;
    // A letter of this session past what it made: another replica has it.
    const last = `${ids.session(s)}.${numberToBase64(c + text.length - 1)}`;
    if (ids.collides(last)) ids.renew();
    insertLetters(target.state, target.index, text, s, c);
  },

  delete: (doc, start, end) => {
    const range = rangeOf(doc, start, end);
    if (range) deleteLetters(range.state, range.index, range.length);
  },

  move: (doc, operation) => {
    const [, first, last, nodeId, prev, next, key] = operation;
    // A border of the range is gone: the move is dropped, like a delete.
    const range = rangeOf(doc, first, last);
    if (!range) return;
    const { state: source, index, length } = range;
    const target = targetOf(doc, nodeId, prev, next, key);
    if (!target) return;
    let at = target.index;
    if (target.state === source) {
      // Into the moved letters, or right before or after them: no change.
      if (at >= index && at <= index + length) return;
      if (at > index) at -= length;
    }
    moveLetters(source, index, length, target.state, at);
  },

  /**
   * The `letters` column: for each non-empty text, in the order the document
   * writes its values (the root's, then each node's in preorder, by key),
   * the runs of its letters, as Loro stores a text: its string and its id
   * runs. A run is written as the id runs of nodes (`IdsWriter`, `main.ts`):
   * its session minus the previous run's (0 before the first run), and its
   * first clock minus the clock that follows the last letter written of its
   * session (0 before any).
   *
   * - Odd first number, `2 * clock + 1`: a run of the previous run's session.
   * - Even, `2 * session`: then its clock.
   * - Then its length; `0` in the last run of a text: the rest of its string.
   *
   * With sessions `["A", "B"]`, the texts "Hola, mundo" ("Hola" clocks 0-3
   * of A, "," clock 0 of B, " mundo" clocks 4-9 of A) and "chau" (clocks
   * 10-13 of A) are:
   *
   * ```
   * [0, 0, 4,  2, 0, 1,  -2, 0, 0,  1, 0]
   *  A  0  4   B  0  1    A  0 rest  A,0 rest
   * ```
   *
   * The `0` clocks of A are 0 after the start, after "Hola" (4) and after
   * " mundo" (10).
   */
  lettersWriter: (sessionIndex) => {
    const column: number[] = [];
    const nextClocks: number[] = [];
    let lastSession = 0;
    const push = (s: number, c: number, length: number, last: boolean) => {
      const session = sessionIndex(s);
      const clock = c - (nextClocks[session] ?? 0);
      const stored = last ? 0 : length;
      if (session === lastSession) column.push(2 * clock + 1, stored);
      else column.push(2 * (session - lastSession), clock, stored);
      lastSession = session;
      nextClocks[session] = c + length;
    };
    return {
      column,
      write: (node, key) => {
        const runs = stateOf(node, key).runs;
        // Runs that follow in clock are written as one.
        let { s, c } = runs[0]!;
        let length = runs[0]!.text.length;
        for (let i = 1; i < runs.length; i++) {
          const run = runs[i]!;
          if (run.s === s && run.c === c + length) {
            length += run.text.length;
            continue;
          }
          push(s, c, length, false);
          ({ s, c } = run);
          length = run.text.length;
        }
        push(s, c, length, true);
      },
    };
  },

  lettersReader: (column, sessions) => {
    if (column !== undefined && !Array.isArray(column))
      throw invalidLetters("its letters are not valid");
    const numbers: readonly unknown[] = column ?? [];
    const nextClocks = sessions.map(() => 0);
    let at = 0;
    let session = 0;
    /** The next number of the column, an integer. */
    const next = () => {
      const number = numbers[at++];
      if (typeof number === "number" && Number.isInteger(number)) return number;
      throw invalidLetters("it has a letter run that is not valid");
    };
    return {
      read: (node, key, text) => {
        if (at === numbers.length)
          throw invalidLetters("it has fewer letter runs than texts");
        const state = new TextState(node, key);
        for (let start = 0; start < text.length; ) {
          // Its form by the parity of its first number. Not `% 2 === 1`:
          // -3 % 2 is -1.
          const first = next();
          let delta: number;
          if (first % 2 === 0) {
            session += first / 2;
            delta = next();
          } else delta = (first - 1) / 2;
          const length = next();
          const left = text.length - start;
          const clock = nextClocks[session]! + delta;
          const size = length === 0 ? left : length;
          if (
            !(session in sessions) ||
            length < 0 ||
            length > left ||
            clock < 0 ||
            clock + size - 1 > MAX_CLOCK
          )
            throw invalidLetters("it has a letter run that is not valid");
          nextClocks[session] = clock + size;
          const end = start + size;
          state.runs.push(
            new Run(sessions[session]!, clock, text.slice(start, end), state),
          );
          start = end;
        }
        state.length = text.length;
        state.cached = text;
        return state;
      },
      end: () => {
        if (at !== numbers.length)
          throw invalidLetters("it has more letter runs than texts");
      },
    };
  },
};
