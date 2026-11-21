import type { Doc } from "../main.js";
import type { Json } from "../types.js";
import type { EditOperation } from "../operations.js";
import { lastDot, numberToBase64 } from "../idGenerator.js";
import {
  ColumnReader,
  ColumnWriter,
  FieldReader,
  FieldWriter,
  joinColumns,
  joinId,
  readSessions,
  SessionTable,
  splitColumns,
} from "../columns.js";
import {
  contentOf,
  cutIn,
  decodeRef,
  encodeRange,
  encodeRef,
  isHighSurrogate,
  isLowSurrogate,
  isRecord,
  lettersOf,
  listOf,
  nextId,
  pushRange,
  rulesOfNode,
  sameValue,
  SessionRuns,
  stateOfContent,
  stringOf,
  TextEngine,
  type Rules,
  type TextSpan,
} from "./common.js";
import { TreePositions, type Item, type Leaf } from "./positions.js";
import { Ghosts, type Ghost } from "./ghosts.js";

/**
 * Base's text: it relies on the server's order, as the tree does. Every
 * replica applies the same operations in the same order, so its rules only
 * need to be deterministic, not commutative (`text/store.ts` is the text of
 * the CRDT mode).
 *
 * - Each node has a list of live letters. A letter has a permanent id
 *   `(session, counter)`; consecutive ids of one session with one state are
 *   one run.
 * - Deleting removes letters for good: no tombstones. What is left of them
 *   is a ghost (see `Ghosts`): their ids and the letter before them.
 * - An insert names the letters on both sides. The left one exists: right
 *   after it. Else the right one exists: right before it. Else it goes
 *   where the left one was deleted: right after the anchor of its ghost.
 *   Only after an insert that was lost (it named a node not here) can it be
 *   lost too.
 * - A letter's state is its own: what it inherits (see `Inherit`) is copied
 *   into it when it is inserted, from the letters it lands between. Every
 *   replica inserts it between the same letters.
 * - `setLetterState`: the last one applied wins.
 * - An undo of a delete inserts the letters again, with their ids and the
 *   state they had. Their ids: a later undo (of the insert that made them)
 *   names them, and two undos of one delete bring them back once.
 */

/** A letter's state: never changed in place, runs share it (see `_intern`). */
type State = Readonly<Record<string, Json>>;

class Run implements Item<Run> {
  prev: Run | undefined;
  next: Run | undefined;
  leaf: Leaf<Run> | undefined;
  vis = 0;
  /** Whether a ghost may be anchored at one of its letters (see `Ghosts`). */
  anchors = false;

  constructor(
    readonly s: string,
    public c: number,
    public text: string,
    public state: State | undefined,
    readonly flow: Flow,
  ) {}

  get len(): number {
    return this.text.length;
  }

  /** Every letter of the list is (see `Item`): deleted ones are gone. */
  readonly visible = true;
}

/** The list of one node: its root (a run without letters), then its letters. */
class Flow {
  readonly head: Run;
  constructor(readonly node: string) {
    this.head = new Run(node, -1, "", undefined, this);
  }
}

/** A letter, possibly in the middle of a run; a node's root is its start. */
type Element = { run: Run; off: number };

/** The values a `setLetterState` replaced, by their JSON: the ranges of each. */
type OldValues = Map<string, [Json, [string, number, number][]]>;

const TAG_DELETE = 1;
const TAG_RESTORE = 4;
const TAG_STATE = 5;
const TAG_FORMAT = 6;

/**
 * A long node id without a session: named by a prefix of its hash (see
 * `_startRef`). Ids of a session are short on the wire.
 */
const hashable = (id: string) => id.length > 6 && lastDot(id) === -1;

/** 30 bits of FNV-1a of `id`, mixed so that every letter moves them all. */
function idHash(id: string): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < id.length; at++) {
    hash ^= id.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return numberToBase64((hash >>> 2) + 0x40000000).slice(1);
}

/** A letter's reference from an operation of `own` (see `encodeRef`). */
const refTo = (own: string, { run, off }: Element) =>
  encodeRef(own, run.s, run.c + off);

export class BaseText extends TextEngine {
  private _session: string | undefined;
  private _counter = 0;
  private _renewals = 0;
  private _doc: Doc | undefined;
  private _index = new Map<string, SessionRuns<Run>>();
  private _flows = new Map<string, Flow>();
  /** The hash of each node id hashed so far (see `_startRef`). */
  private _hashes = new Map<string, string>();
  /** Each distinct state, by its JSON (see `_intern`). */
  private _states = new Map<string, State>();
  /**
   * The operations of the transaction being written, and the first counter
   * it minted: letters of this session from it on came in the same batch.
   */
  private _txOps: unknown;
  private _txStart = 0;
  protected _positions = new TreePositions<Run>();
  /** Where deleted letters were (see `Ghosts`). */
  protected _ghosts = new Ghosts();

  bind(doc: Doc): void {
    this._doc = doc;
  }

  /**
   * Base reads the rules of a node from its type, when the letters are
   * inserted (see `_rules`): every replica reads the same.
   */
  setRules(): void {
    // Nothing to keep.
  }

  /** The rules of a node's type while it is in the document. */
  private _rules(flow: Flow): Rules | undefined {
    const rules = rulesOfNode(this._doc, flow.node);
    return rules === false ? undefined : rules;
  }

  // ----- identity --------------------------------------------------------

  private _mint(doc: Doc, length: number): [string, number] {
    if (
      this._session === undefined ||
      this._renewals !== doc["_sessionRenewals"]
    ) {
      const id = doc["_nodeIdGenerator"](doc);
      const dot = lastDot(id);
      this._session = dot === -1 ? id : id.slice(0, dot);
      this._renewals = doc["_sessionRenewals"];
      // A custom generator names the same session after a reload: its
      // counters go on after the letters the document holds.
      this._counter = Math.max(
        this._index.get(this._session)?.end() ?? 0,
        this._ghosts.end(this._session),
      );
    }
    const counter = this._counter;
    if (this._txOps !== doc["_operations"]) {
      this._txOps = doc["_operations"];
      this._txStart = counter;
    }
    this._counter += length;
    return [this._session, counter];
  }

  /**
   * Whether `element` was inserted earlier in the batch being written: the
   * server applies a batch as a whole, so nobody deletes it before.
   */
  private _local(doc: Doc, { run, off }: Element): boolean {
    return (
      run.s === this._session &&
      run.c + off >= this._txStart &&
      this._txOps === doc["_operations"]
    );
  }

  private _find(s: string, c: number): Element | undefined {
    const run = this._index.get(s)?.find(c);
    return run && { run, off: c - run.c };
  }

  private _indexRun(run: Run): void {
    let runs = this._index.get(run.s);
    if (!runs) this._index.set(run.s, (runs = new SessionRuns<Run>()));
    runs.add(run);
  }

  private _flow(node: string): Flow {
    let flow = this._flows.get(node);
    if (!flow) this._flows.set(node, (flow = new Flow(node)));
    return flow;
  }

  /**
   * The start of a node's text: `^` for the root's, which every replica has,
   * `#` and the shortest prefix of the hash of its id that no other node
   * has here (see `hashable`), or `^node`.
   */
  private _startRef(doc: Doc, node: string): string {
    if (node === doc.root.id) return "^";
    if (!hashable(node)) return `^${node}`;
    const hash = this._hash(node);
    // How many first digits it shares with the closest other one.
    let shared = 0;
    this._eachHashable(doc, (id) => {
      if (id === node) return;
      const other = this._hash(id);
      let same = 0;
      while (same < hash.length && other[same] === hash[same]) same++;
      if (same > shared) shared = same;
    });
    // Two ids with one whole hash (30 bits) name the first of them.
    return `#${hash.slice(0, shared + 1)}`;
  }

  /**
   * The start a reference names, as an element: of the nodes `#prefix` could
   * name, the one whose hash starts so (the first id in order if several
   * do); none if none.
   */
  private _start(doc: Doc, ref: string): Element | undefined {
    let node: string | undefined = ref.slice(1) || doc.root.id;
    if (ref.charCodeAt(0) === 35) {
      let found: string | undefined;
      this._eachHashable(doc, (id) => {
        if (
          this._hash(id).startsWith(node!) &&
          (found === undefined || id < found)
        )
          found = id;
      });
      node = found;
    }
    return node === undefined
      ? undefined
      : { run: this._flow(node).head, off: 0 };
  }

  private _hash(id: string): string {
    let hash = this._hashes.get(id);
    if (hash === undefined) this._hashes.set(id, (hash = idHash(id)));
    return hash;
  }

  /**
   * Calls `visit` with each id `#` could name: the nodes of the tree, and
   * those whose text is not empty (the same in every replica that applied
   * the same operations, also after a reload).
   */
  private _eachHashable(doc: Doc, visit: (id: string) => void): void {
    const nodes = doc["_nodeMap"];
    for (const id of nodes.keys()) if (hashable(id)) visit(id);
    for (const [id, flow] of this._flows)
      if (flow.head.next && hashable(id) && !nodes.has(id)) visit(id);
  }

  /** One object per distinct state, with sorted keys; none for `{}`. */
  private _intern(values: State | undefined): State | undefined {
    if (!values) return undefined;
    const keys = Object.keys(values).sort();
    if (keys.length === 0) return undefined;
    const sorted: Record<string, Json> = {};
    for (const key of keys) sorted[key] = values[key]!;
    const json = JSON.stringify(sorted);
    let state = this._states.get(json);
    if (!state) this._states.set(json, (state = sorted));
    return state;
  }

  // ----- the list ----------------------------------------------------------

  private _after({ run, off }: Element): Element | undefined {
    if (off + 1 < run.len) return { run, off: off + 1 };
    return run.next && { run: run.next, off: 0 };
  }

  private _linkAfter(target: Run, run: Run): void {
    this._positions.linked(target, run, true);
    const next = target.next;
    target.next = run;
    run.prev = target;
    run.next = next;
    if (next) next.prev = run;
  }

  private _unlink(run: Run): void {
    this._positions.removed(run);
    run.prev!.next = run.next;
    if (run.next) run.next.prev = run.prev;
    const runs = this._index.get(run.s)!;
    runs.remove(run);
    // A session without letters is no more: its runs are never empty.
    if (runs.empty) this._index.delete(run.s);
  }

  /** Cuts `run` at `offset`: the new run after it. */
  private _split(run: Run, offset: number): Run {
    const tail = new Run(
      run.s,
      run.c + offset,
      run.text.slice(offset),
      run.state,
      run.flow,
    );
    tail.anchors = run.anchors;
    run.text = run.text.slice(0, offset);
    this._positions.changed(run);
    this._indexRun(tail);
    this._linkAfter(run, tail);
    return tail;
  }

  /** The run that starts at `element`, cut from its run if needed. */
  private _startingAt({ run, off }: Element): Run {
    return off === 0 ? run : this._split(run, off);
  }

  /** Joins `run` with the runs around it it only differs from by being apart. */
  private _join(run: Run): void {
    while (run.prev && joins(run.prev, run)) run = run.prev;
    while (run.next && joins(run, run.next)) {
      const next = run.next;
      this._unlink(next);
      run.text += next.text;
      if (next.anchors) run.anchors = true;
      this._positions.changed(run);
    }
  }

  // ----- reading ---------------------------------------------------------

  textOf(node: string): string {
    let text = "";
    const flow = this._flows.get(node);
    if (!flow) return text;
    for (let run = flow.head.next; run; run = run.next) text += run.text;
    return text;
  }

  spansOf(node: string): TextSpan[] {
    const out: TextSpan[] = [];
    const flow = this._flows.get(node);
    if (!flow) return out;
    let state: State | undefined;
    for (let run = flow.head.next; run; run = run.next) {
      if (out.length > 0 && run.state === state)
        out[out.length - 1]!.text += run.text;
      else {
        state = run.state;
        out.push({ text: run.text, attrs: { ...state } });
      }
    }
    return out;
  }

  lengthOf(node: string): number {
    const flow = this._flows.get(node);
    return flow ? this._positions.length(flow.head) : 0;
  }

  letterAt(node: string, index: number): string | undefined {
    const flow = this._flows.get(node);
    if (!flow || index < 0 || index >= this._positions.length(flow.head))
      return undefined;
    const { run, off } = this._positions.seek(flow.head, index);
    return `${run.s}:${run.c + off}`;
  }

  /** A deleted letter is where its ghost is: right after its anchor. */
  indexOfLetter(node: string, letter: string): number | undefined {
    const flow = this._flows.get(node);
    const parts = /^(.*):(\d+)$/s.exec(letter);
    if (!flow || !parts) return undefined;
    const s = parts[1]!;
    const c = Number(parts[2]);
    const found = this._find(s, c) ?? this._anchorOf(s, c);
    if (found?.run.flow !== flow) return undefined;
    if (found.run.c === -1) return 0;
    const index = this._positions.before(flow.head, found.run) + found.off;
    return this._find(s, c) ? index : index + 1;
  }

  /** `index` clamped to the text and moved off the middle of a surrogate pair. */
  private _boundary(flow: Flow, index: number): number {
    // Before the index of positions is needed: typing at the start of every
    // text of many documents builds none.
    if (index <= 0) return 0;
    const length = this._positions.length(flow.head);
    if (index >= length) return length;
    const left = this._positions.seek(flow.head, index - 1);
    const right = this._after(left)!;
    return isHighSurrogate(left.run.text.charCodeAt(left.off)) &&
      isLowSurrogate(right.run.text.charCodeAt(right.off))
      ? index + 1
      : index;
  }

  /** The letter right before boundary `index`; the node's root for 0. */
  private _leftOf(flow: Flow, index: number): Element {
    if (index === 0) return { run: flow.head, off: 0 };
    return this._positions.seek(flow.head, index - 1);
  }

  /** The letters from `from` to `to` (visible indexes), as id ranges. */
  private _ranges(flow: Flow, from: number, to: number) {
    const ranges: [string, number, number][] = [];
    from = this._boundary(flow, from);
    to = this._boundary(flow, to);
    if (to <= from) return ranges;
    let { run, off } = this._positions.seek(flow.head, from);
    for (let left = to - from; left > 0; run = run.next!, off = 0) {
      const take = Math.min(run.len - off, left);
      pushRange(ranges, run.s, run.c + off, take);
      left -= take;
    }
    return ranges;
  }

  // ----- local operations ---------------------------------------------------

  private _record(
    doc: Doc,
    operation: EditOperation,
    inverse: EditOperation,
  ): void {
    doc["_operations"][0].push(operation);
    doc["_inverseOperations"][0].push(inverse);
    doc["_hasEdits"] = true;
  }

  private _commit(doc: Doc, payload: EditOperation): void {
    const inverse = this.apply(doc, payload);
    if (inverse) this._record(doc, payload, inverse);
  }

  /**
   * `insertLetters`, at a visible index. `attrs`: the state the letters
   * have, else what they inherit (see `Inherit`).
   */
  insert(
    doc: Doc,
    node: string,
    index: number,
    text: string,
    attrs?: Record<string, Json>,
  ): void {
    if (text.length === 0) return;
    const flow = this._flow(node);
    const left = this._leftOf(flow, this._boundary(flow, index));
    const right = this._after(left);
    const rules = this._rules(flow);
    const own = attrs && ownFor(rules, text, left, right, attrs);
    const [s, c] = this._mint(doc, text.length);
    const payload: EditOperation = [3, s, c, contentOf(text, own)];
    if (left.run.c === -1) payload.push(this._startRef(doc, node));
    else this._neighbours(doc, payload, s, c, left, right);
    const inverse = this._insert(doc, s, c, text, own, rules, left, right);
    this._record(doc, payload, inverse);
  }

  /**
   * The neighbours of an insert of `[3, s, c, content]` (see the format):
   * only what the receiver needs to find `left`, or `right` if it is gone.
   */
  private _neighbours(
    doc: Doc,
    payload: EditOperation,
    s: string,
    c: number,
    left: Element,
    right: Element | undefined,
  ): void {
    const ls = left.run.s;
    const lc = left.run.c + left.off;
    const rightRef = right ? refTo(s, right) : 0;
    if (ls === s && lc === c - 1) {
      // The letter typed before: left out.
      if (rightRef !== 0 && !this._local(doc, left)) payload.push(rightRef);
    } else if (right?.run.s === ls && right.run.c + right.off === lc + 1) {
      // The left one is the id before the right one: the sign says so.
      if (typeof rightRef === "number") payload.push(-rightRef);
      else payload.push(rightRef, 0);
    } else if (this._local(doc, left)) payload.push(0, encodeRef(s, ls, lc));
    else if (right && this._local(doc, right)) payload.push(rightRef, -1);
    else payload.push(rightRef, encodeRef(s, ls, lc));
  }

  /** `setLetterState` of a visible range. `value: null` removes the key. */
  format(
    doc: Doc,
    node: string,
    from: number,
    to: number,
    key: string,
    value: Json,
  ): void {
    const flow = this._flow(node);
    const ranges = this._ranges(flow, from, to);
    if (ranges.length === 0) return;
    const [s, c] = this._mint(doc, 0);
    if (this._rules(flow)?.get(key) !== "origin") {
      const payload: EditOperation = [3, TAG_STATE, s, c, key];
      payload.push(encodeRanges(s, ranges));
      if (value !== null) payload.push(value);
      this._commit(doc, payload);
      return;
    }
    // A key letters inherit from the one before: the letter after the range
    // too, so that what others type right after it goes with it.
    const payload: EditOperation = [3, TAG_FORMAT, s, c, key];
    payload.push(encodeRanges(s, ranges), value);
    const end = this._boundary(flow, to);
    const [ls, lc, len] = ranges.at(-1)!;
    if (end >= this._positions.length(flow.head)) payload.push(0);
    else {
      const after = this._positions.seek(flow.head, end);
      if (after.run.s !== ls || after.run.c + after.off !== lc + len)
        payload.push(refTo(s, after));
    }
    this._commit(doc, payload);
  }

  /** Deletes a visible range: its letters leave the list. */
  delete(doc: Doc, node: string, index: number, length: number): void {
    const ranges = this._ranges(this._flow(node), index, index + length);
    if (ranges.length === 0) return;
    const [s, c] = this._mint(doc, 0);
    this._commit(doc, [3, TAG_DELETE, s, c, encodeRanges(s, ranges)]);
  }

  /** What an undo of the history applies: the operation as it is. */
  prepareUndo(_doc: Doc, undo: EditOperation): EditOperation {
    return undo;
  }

  // ----- applying operations ---------------------------------------------

  apply(doc: Doc, payload: EditOperation): EditOperation | undefined {
    const tag = payload[1];
    if (typeof tag === "string") return this._applyInsert(doc, payload, tag);
    const s = stringOf(payload[2]);
    const c = Number(payload[3]);
    switch (tag) {
      case TAG_DELETE:
        return this._applyDelete(doc, s, c, decodeRanges(s, payload[4]!));
      case TAG_RESTORE:
        return this._applyRestore(doc, payload, s, c);
      case TAG_STATE:
        return this._applyState(doc, payload, s, c);
      case TAG_FORMAT:
        return this._applyFormat(doc, payload, s, c);
      default:
        return undefined;
    }
  }

  /** Letters of this replica's session it did not write: a copy's (see `NodeIds`). */
  private _checkSession(doc: Doc, s: string, end: number): void {
    if (s === this._session && end > this._counter) doc["_renewSession"]();
  }

  private _applyInsert(
    doc: Doc,
    payload: EditOperation,
    s: string,
  ): EditOperation | undefined {
    let c = Number(payload[2]);
    const content = payload[3];
    let text = lettersOf(content);
    this._checkSession(doc, s, c + text.length);
    // Applied already (a batch delivered twice, maybe fused with the next
    // ones): the known prefix is skipped, the rest follows its last letter.
    // Ids that are ghosts were applied, and deleted since.
    let known = 0;
    while (known < text.length) {
      const found = this._find(s, c + known);
      if (found) known += found.run.len - found.off;
      else {
        const ghost = this._ghosts.find(s, c + known);
        if (!ghost) break;
        known = ghost.c + ghost.len - c;
      }
    }
    if (known >= text.length) return undefined;
    // A later letter of it is here (the first ones were deleted since):
    // never two letters with one id.
    if (
      this._index.get(s)?.overlaps(c + known, text.length - known) ||
      this._ghosts.overlaps(s, c + known, text.length - known)
    )
      return undefined;
    let right = payload[4];
    let left = payload[5];
    let at: Element | undefined;
    let next: Element | undefined;
    let around: [State | undefined, State | undefined] | undefined;
    if (known > 0) {
      c += known;
      text = text.slice(known);
      at = this._find(s, c - 1);
      next = at && this._after(at);
    } else if (isStart(right)) {
      at = this._start(doc, right);
      next = at && this._after(at);
    } else {
      if (typeof right === "number" && right < 0) {
        right = -right;
        left = 0;
      }
      const [rs, rc] =
        right === undefined || right === 0 ? ["", -1] : decodeRef(s, right);
      const [ls, lc] =
        left === undefined
          ? [s, c - 1]
          : left === 0
            ? [rs, rc - 1]
            : left === -1
              ? ["", -1]
              : decodeRef(s, left);
      at = this._find(ls, lc);
      next = at ? this._after(at) : this._find(rs, rc);
      // Right before `next`: after the letter before it.
      if (!at && next) at = this._before(next);
      // Both deleted: where the left one was.
      if (!at) {
        at = this._anchorOf(ls, lc);
        next = at && this._after(at);
      }
      around = this._ghostStates(at, next, ls, lc, rs, rc);
    }
    if (!at) return undefined;
    const flow = at.run.flow;
    return this._insert(
      doc,
      s,
      c,
      text,
      stateOfContent(content),
      this._rules(flow),
      at,
      next,
      around,
    );
  }

  /**
   * What letters typed between `(ls, lc)` and `(rs, rc)` inherit from them,
   * when one of them is a ghost: its state, as if it were still there
   * (see `Ghost.state`). Undefined when both are where the insert lands.
   */
  private _ghostStates(
    at: Element | undefined,
    next: Element | undefined,
    ls: string,
    lc: number,
    rs: string,
    rc: number,
  ): [State | undefined, State | undefined] | undefined {
    if (!at || this._ghosts.empty) return undefined;
    const left = at.run.c === -1 ? undefined : at.run.state;
    const right = next?.run.state;
    const leftGhost =
      at.run.s === ls && at.run.c + at.off === lc
        ? undefined
        : this._ghosts.find(ls, lc);
    const rightGhost =
      rc === -1 || (next?.run.s === rs && next.run.c + next.off === rc)
        ? undefined
        : this._ghosts.find(rs, rc);
    if (!leftGhost && !rightGhost) return undefined;
    return [
      leftGhost ? leftGhost.state : left,
      rightGhost ? rightGhost.state : right,
    ];
  }

  /** The anchor of the ghost of deleted letter `(s, c)`, if it is one. */
  private _anchorOf(s: string, c: number): Element | undefined {
    const ghost = this._ghosts.find(s, c);
    if (!ghost) return undefined;
    return ghost.ac === -1
      ? { run: this._flow(ghost.as).head, off: 0 }
      : this._find(ghost.as, ghost.ac);
  }

  /** The letter (or start) right before `element`. */
  private _before({ run, off }: Element): Element {
    if (off > 0) return { run, off: off - 1 };
    const prev = run.prev!;
    return { run: prev, off: Math.max(prev.len - 1, 0) };
  }

  /**
   * Inserts letters right after `left` (and before `right`, the element
   * after it), with what they inherit from both copied into their state:
   * the letters before the first opaque one (see `Rules.opaque`).
   */
  private _insert(
    doc: Doc,
    s: string,
    c: number,
    text: string,
    own: Record<string, Json> | undefined,
    rules: Rules | undefined,
    left: Element,
    right: Element | undefined,
    around?: [State | undefined, State | undefined],
  ): EditOperation {
    const flow = left.run.flow;
    const cut = rules ? cutIn(text, rules.opaque) : 0;
    let target = left.run;
    if (left.off < target.len - 1) this._split(target, left.off + 1);
    const place = (from: number, to: number, state: State | undefined) => {
      if (
        target.c !== -1 &&
        target.s === s &&
        target.c + target.len === c + from &&
        target.state === state
      ) {
        // Typing: the letters go on the run before them.
        target.text += text.slice(from, to);
        this._positions.changed(target);
        return;
      }
      const run = new Run(s, c + from, text.slice(from, to), state, flow);
      this._indexRun(run);
      this._linkAfter(target, run);
      target = run;
    };
    // `cut` is 0 without rules: nothing to inherit.
    if (cut > 0) {
      const [before, after] = around ?? [
        left.run.c === -1 ? undefined : left.run.state,
        right?.run.state,
      ];
      place(0, cut, this._stateFor(rules!, before, after, own));
    }
    if (cut < text.length) place(cut, text.length, this._ownState(own));
    this._report(doc, flow.node);
    return [3, TAG_DELETE, s, c, encodeRange(s, s, c, text.length)];
  }

  /**
   * The state of letters with `own` state typed between letters with `left`
   * and `right` state: what they inherit (see `Inherit`) and their own
   * (`null`: a key they do not take).
   */
  private _stateFor(
    rules: Rules,
    left: State | undefined,
    right: State | undefined,
    own: Record<string, Json> | undefined,
  ): State | undefined {
    let state: Record<string, Json> | undefined;
    // While every key of `left` goes on and there is no own state, it is
    // `left` itself.
    let same = !own;
    for (const key in left) {
      const value = left[key]!;
      const rule = rules.get(key);
      if (
        rule === undefined ||
        (own && Object.hasOwn(own, key)) ||
        (rule === "both" &&
          !(
            right &&
            Object.hasOwn(right, key) &&
            sameValue(value, right[key]!)
          ))
      ) {
        same = false;
        continue;
      }
      (state ??= {})[key] = value;
    }
    // `same` means no own state: the loop adds nothing.
    for (const key in own)
      if (own[key] !== null) (state ??= {})[key] = own[key]!;
    return same ? left : this._intern(state);
  }

  /** The state of letters that inherit nothing: their own, without `null`s. */
  private _ownState(own: Record<string, Json> | undefined): State | undefined {
    let state: Record<string, Json> | undefined;
    if (own)
      for (const key in own)
        if (own[key] !== null) (state ??= {})[key] = own[key]!;
    return this._intern(state);
  }

  /** `[3, 1, s, c, ranges]`: the letters leave their list. */
  private _applyDelete(
    doc: Doc,
    s: string,
    c: number,
    ranges: [string, number, number][],
  ): EditOperation | undefined {
    const removed: Run[] = [];
    for (const [rs, rc, len] of ranges)
      for (let k = 0; k < len; ) {
        const found = this._find(rs, rc + k);
        if (!found) {
          k++;
          continue;
        }
        const take = Math.min(found.run.len - found.off, len - k);
        const run = this._startingAt(found);
        if (take < run.len) this._split(run, take);
        removed.push(run);
        k += take;
      }
    if (removed.length === 0) return undefined;
    // Its undo goes back between the letters around it. Ranges are in the
    // order of the list, which never changes: those before the first one and
    // after the last one stay.
    const left = removed[0]!.prev!;
    const right = removed.at(-1)!.next;
    const rules = this._rules(left.flow);
    let text = "";
    const ids: [string, number, number][] = [];
    const states: Json[] = [];
    let styled = false;
    let last: State | undefined;
    for (const run of removed) {
      text += run.text;
      pushRange(ids, run.s, run.c, run.len);
      if (states.length > 0 && run.state === last)
        states[states.length - 2] = Number(states.at(-2)) + run.len;
      else states.push(run.len, run.state ?? 0);
      last = run.state;
      if (run.state) styled = true;
      // Its ghost: after the letter before it, which stays.
      const before = run.prev!;
      const kept = this._inheritable(run.state, rules);
      if (before.c === -1)
        this._ghosts.add(
          run.s,
          run.c,
          run.len,
          before.flow.node,
          -1,
          run.anchors,
          kept,
        );
      else {
        this._ghosts.add(
          run.s,
          run.c,
          run.len,
          before.s,
          before.c + before.len - 1,
          run.anchors,
          kept,
        );
        before.anchors = true;
      }
      this._unlink(run);
    }
    this._report(doc, left.flow.node);
    const inverse: EditOperation = [
      3,
      TAG_RESTORE,
      s,
      c,
      text,
      encodeRanges(s, ids),
      styled ? states : 0,
    ];
    // The letters around them, unless they are the ids right before the
    // first one and after the last one (`-1`), as when part of what was
    // typed in a row is deleted.
    const [fs, fc] = ids[0]!;
    const [ls, lc, len] = ids.at(-1)!;
    inverse.push(
      !right
        ? 0
        : right.s === ls && right.c === lc + len
          ? -1
          : refTo(s, { run: right, off: 0 }),
    );
    inverse.push(
      left.c === -1
        ? this._startRef(doc, left.flow.node)
        : left.s === fs && left.c + left.len === fc
          ? -1
          : refTo(s, { run: left, off: left.len - 1 }),
    );
    // What says nothing at the end is left out: `-1`s, then no state.
    if (inverse[8] === -1) {
      inverse.pop();
      if (inverse[7] === -1) {
        inverse.pop();
        if (!styled) inverse.pop();
      }
    }
    return inverse;
  }

  /**
   * What of `state` a letter typed next to it can inherit (see `Inherit`):
   * the keys with a rule. A ghost keeps it (see `Ghost.state`).
   */
  private _inheritable(
    state: State | undefined,
    rules: Rules | undefined,
  ): State | undefined {
    if (!state || !rules) return undefined;
    let cache = keptByRules.get(rules);
    if (!cache) keptByRules.set(rules, (cache = new WeakMap()));
    let kept = cache.get(state);
    if (kept === undefined) {
      let some: Record<string, Json> | undefined;
      for (const key in state)
        if (rules.get(key) !== undefined) (some ??= {})[key] = state[key]!;
      kept = some === undefined ? false : this._intern(some)!;
      cache.set(state, kept);
    }
    return kept === false ? undefined : kept;
  }

  /**
   * `[3, 4, s, c, text, ids, states?, right?, left?]`: letters a delete
   * took, back with their `ids` (ranges, in order) and their state
   * (`states`: `length, state` each; `0` for none), before `right` or else
   * after `left`: what was typed where they were since goes before them.
   * `right` and `left` left out (or `-1`) are the ids right after the last
   * letter and before the first; a `0` right is none. Those still here stay
   * where they are, and the others follow them.
   */
  private _applyRestore(
    doc: Doc,
    payload: EditOperation,
    s: string,
    c: number,
  ): EditOperation | undefined {
    const text = stringOf(payload[4]);
    const ranges = decodeRanges(s, payload[5]!);
    const [fs, fc] = ranges[0]!;
    const [ls, lc, len] = ranges.at(-1)!;
    const right = payload[7] ?? -1;
    const left = payload[8] ?? -1;
    const next =
      right === 0
        ? undefined
        : right === -1
          ? this._find(ls, lc + len)
          : this._find(...decodeRef(s, right));
    const [as, ac] = isStart(left)
      ? ["", -1]
      : left === -1
        ? [fs, fc - 1]
        : decodeRef(s, left);
    let at = next
      ? this._before(next)
      : isStart(left)
        ? this._start(doc, left)
        : this._find(as, ac);
    // Both deleted: where the left one was.
    at ??= this._anchorOf(as, ac);
    if (!at) return undefined;
    const states = listOf(payload[6]) ?? [text.length, 0];
    const back: [string, number, number][] = [];
    let from = 0;
    let piece = 0;
    let pieceLeft = 0;
    let state: State | undefined;
    for (const [rs, rc, length] of ranges) {
      this._checkSession(doc, rs, rc + length);
      for (let k = 0; k < length; k++, from++, pieceLeft--) {
        if (pieceLeft === 0) {
          pieceLeft = Number(states[piece]);
          const written = states[piece + 1];
          state = isState(written) ? this._intern(written) : undefined;
          piece += 2;
        }
        const found = this._find(rs, rc + k);
        if (found) {
          at = found;
          continue;
        }
        at = this._place(at, rs, rc + k, text[from]!, state);
        pushRange(back, rs, rc + k, 1);
      }
    }
    if (back.length === 0) return undefined;
    for (const [rs, rc, length] of back) this._ghosts.drop(rs, rc, length);
    // Back with their ids, they may go on the run after them again.
    this._join(at.run);
    this._report(doc, at.run.flow.node);
    return [3, TAG_DELETE, s, c, encodeRanges(s, back)];
  }

  /**
   * Puts letter `(s, c)` right after `at`, on the run of `at` when it goes
   * on it. Returns where it is.
   */
  private _place(
    at: Element,
    s: string,
    c: number,
    letter: string,
    state: State | undefined,
  ): Element {
    const target = at.run;
    if (at.off < target.len - 1) this._split(target, at.off + 1);
    if (target.c !== -1 && joins(target, { s, c, state })) {
      target.text += letter;
      this._positions.changed(target);
      return { run: target, off: target.len - 1 };
    }
    const run = new Run(s, c, letter, state, target.flow);
    this._indexRun(run);
    this._linkAfter(target, run);
    return { run, off: 0 };
  }

  /**
   * `[3, 5, s, c, key, ranges, value?, ...]`: a value for each list of
   * ranges, the last one `null` if left out. The last one applied wins.
   *
   * A range is all that is between its first and its last letter still
   * here: its letters were together when it was written, so what others
   * typed inside it since is in it too, like the text a peer types in a
   * word that gets bold or a link.
   */
  private _applyState(
    doc: Doc,
    payload: EditOperation,
    s: string,
    c: number,
  ): EditOperation | undefined {
    const key = stringOf(payload[4]);
    const old: OldValues = new Map();
    const touched: Run[] = [];
    for (let at = 5; at < payload.length; at += 2) {
      const value = at + 1 < payload.length ? payload[at + 1]! : null;
      for (const range of decodeRanges(s, payload[at]!)) {
        const [first, last] = this._ends([range]);
        if (first && last)
          this._setBetween(first, last, key, value, old, touched);
      }
    }
    return this._stateDone(doc, s, c, key, old, touched);
  }

  /**
   * `[3, 6, s, c, key, ranges, value, right?]`: `setLetterState` of a key
   * letters inherit from the letter before them (`"origin"`, see
   * `Inherit`). Its ranges were together: all that is between the first
   * and the last letter still here takes the value, as in `_applyState`.
   * So do the letters typed since right after them and before `right`, the
   * letter that was after them, if they have the value the last one had
   * (they would have inherited it), up to an opaque one. `right` left out
   * is the id after the last range; `0`, the end of the text.
   */
  private _applyFormat(
    doc: Doc,
    payload: EditOperation,
    s: string,
    c: number,
  ): EditOperation | undefined {
    const key = stringOf(payload[4]);
    const value = payload[6] ?? null;
    const ranges = decodeRanges(s, payload[5]!);
    const [first, last] = this._ends(ranges);
    if (!first || !last) return undefined;
    const was = last.run.state?.[key] ?? null;
    const ls = last.run.s;
    const lc = last.run.c + last.off;
    const old: OldValues = new Map();
    const touched: Run[] = [];
    this._setBetween(first, last, key, value, old, touched);
    const right = payload[7];
    const [rs, rc, len] = ranges.at(-1)!;
    const [ss, sc] =
      right === undefined
        ? [rs, rc + len]
        : right === 0
          ? ["", -1]
          : decodeRef(s, right);
    const rules = this._rules(last.run.flow);
    if (rules && (sc === -1 || this._find(ss, sc)))
      for (let at = this._after(this._find(ls, lc)!); at; ) {
        const { run, off } = at;
        const length = run.len;
        const stop =
          run.s === ss && sc >= run.c + off && sc < run.c + length
            ? sc - run.c
            : length;
        const end = off + cutIn(run.text.slice(off, stop), rules.opaque);
        const following = run.next;
        if (end > off && sameValue(run.state?.[key] ?? null, was))
          this._setState(run, off, end, key, value, old, touched);
        if (end < length) break;
        at = following && { run: following, off: 0 };
      }
    return this._stateDone(doc, s, c, key, old, touched);
  }

  /** The first and the last letter of `ranges` still here. */
  private _ends(
    ranges: [string, number, number][],
  ): [Element | undefined, Element | undefined] {
    let first: Element | undefined;
    let last: Element | undefined;
    for (const [rs, rc, len] of ranges) {
      for (let k = 0; k < len && !first; k++) first = this._find(rs, rc + k);
      if (first) break;
    }
    for (let at = ranges.length - 1; at >= 0 && !last; at--) {
      const [rs, rc, len] = ranges[at]!;
      for (let k = len - 1; k >= 0 && !last; k--) last = this._find(rs, rc + k);
    }
    return [first, last];
  }

  /** `key` is `value` from `first` to `last`, and on what is between them. */
  private _setBetween(
    first: Element,
    last: Element,
    key: string,
    value: Json,
    old: OldValues,
    touched: Run[],
  ): void {
    for (
      let run: Run | undefined = first.run, from = first.off;
      run;
      from = 0
    ) {
      const end: boolean = run === last.run;
      const to = end ? last.off + 1 : run.len;
      const after: Run | undefined = run.next;
      this._setState(run, from, to, key, value, old, touched);
      run = end ? undefined : after;
    }
  }

  /**
   * `key` is `value` on letters `[from, to)` of `run`, cut from it if
   * needed; what they had goes to `old`.
   */
  private _setState(
    run: Run,
    from: number,
    to: number,
    key: string,
    value: Json,
    old: OldValues,
    touched: Run[],
  ): void {
    const was = run.state?.[key] ?? null;
    if (sameValue(was, value)) return;
    const piece = from > 0 ? this._split(run, from) : run;
    if (to - from < piece.len) this._split(piece, to - from);
    const index = JSON.stringify(was);
    let entry = old.get(index);
    if (!entry) old.set(index, (entry = [was, []]));
    pushRange(entry[1], piece.s, piece.c, piece.len);
    const next: Record<string, Json> = {};
    const state = piece.state;
    if (state)
      for (const other in state) if (other !== key) next[other] = state[other]!;
    if (value !== null) next[key] = value;
    piece.state = this._intern(next);
    touched.push(piece);
  }

  /** Reports the runs `touched` and joins them: the inverse, from `old`. */
  private _stateDone(
    doc: Doc,
    s: string,
    c: number,
    key: string,
    old: OldValues,
    touched: Run[],
  ): EditOperation | undefined {
    if (touched.length === 0) return undefined;
    for (const run of touched) {
      this._report(doc, run.flow.node);
      // Unless it was joined into the run before it already.
      if (run.prev!.next === run) this._join(run);
    }
    const inverse: EditOperation = [3, TAG_STATE, s, c, key];
    // Removals last: a trailing `null` is left out.
    const entries = [...old.values()].sort(
      ([a], [b]) => Number(a === null) - Number(b === null),
    );
    for (const [value, ranges] of entries)
      inverse.push(encodeRanges(s, ranges), value);
    if (inverse.at(-1) === null) inverse.pop();
    return inverse;
  }

  // ----- change reporting --------------------------------------------------

  private _report(doc: Doc, node: string): void {
    const diff = doc["_diff"];
    if (doc.getNodeById(node) && !diff.inserted.has(node))
      diff.updated.add(node);
  }

  // ----- serialization -----------------------------------------------------

  /** `[20, sessions, text, columns, states?]` (see `toStored`). */
  toJSON(): Json {
    const sessions = new SessionTable();
    const columns: { encode(): string }[] = [];
    const stored = this.toStored(sessions, columns);
    if (stored === 0) return 0;
    return [FORMAT, sessions.table, joinColumns(columns), ...stored];
  }

  /**
   * `[text, states?]`, or `0` when there is no text, and its columns in
   * `out`:
   *
   * - `text`: the letters of every list, in order.
   * - Per list: whether its node is not the one after the previous list's
   *   (then its id), and its number of runs.
   * - Per run (runs that only differ by being apart are one): its shape
   *   (length and flags), and only the fields the run before does not imply:
   *   its session, its counter. Per list with state, the runs of each state,
   *   as `count, state` (an index in `states`, plus one).
   * - The ghosts (see `Ghosts`), by their anchor, in the order of the lists
   *   (a list's start, then each letter, is one place): see `GhostWriter`.
   */
  toStored(sessions: SessionTable, out: { encode(): string }[]): Json[] | 0 {
    const ghosts = this._ghosts;
    const flows = this._sortedFlows().filter(
      (flow) => flow.head.next !== undefined || ghosts.hasStart(flow.node),
    );
    if (flows.length === 0) return 0;
    const states: Json[] = [];
    const stateIndexes = new Map<State, number>();
    /** A state's index in `states`, plus one; `0` for none. */
    const stateIndex = (state: State | undefined): number => {
      if (!state) return 0;
      let index = stateIndexes.get(state);
      if (index === undefined) {
        states.push(state);
        stateIndexes.set(state, (index = states.length));
      }
      return index;
    };
    const ghostWriter = new GhostWriter(sessions, ghosts, stateIndex);
    const flowFlags = new ColumnWriter(flows.length, false, true);
    const flowRuns = new ColumnWriter(flows.length);
    const shapeColumn = new ColumnWriter(1024);
    const nodeSessions = new ColumnWriter(flows.length);
    const nodeClocks = new ColumnWriter(flows.length);
    const stateRuns = new ColumnWriter();
    const fields = new FieldWriter();
    const shapeBits: number[] = [];
    const bitsIndex = new Int32Array(BITS.ALL).fill(-1);
    const ends: number[] = [];
    const texts: string[] = [];
    let curSession = 0;
    let expectedKey: string | undefined;
    for (const flow of flows) {
      let flags = 0;
      if (expectedKey !== flow.node) {
        flags |= FLOW.KEY;
        nodeSessions.push(sessions.node(flow.node));
        nodeClocks.push(sessions.clock);
      }
      expectedKey = nextId(flow.node);
      if (!ghosts.empty) {
        ghostWriter.place(flow.node, -1, -1, 1);
      }
      let hasState = false;
      for (let run = flow.head.next; run; run = run.next)
        if (run.state) hasState = true;
      if (hasState) flags |= FLOW.STATES;
      flowFlags.push(flags);
      let runs = 0;
      let lastState = -1;
      let stateCount = 0;
      let prevS = -1;
      let prevC = 0;
      let prevEnd = 0;
      let backS = -1;
      let backEnd = 0;
      for (let run = flow.head.next; run; ) {
        let last: Run = run;
        let text = run.text;
        while (last.next && joins(last, last.next)) {
          last = last.next;
          text += last.text;
        }
        if (!ghosts.empty)
          for (let piece = run; ; piece = piece.next!) {
            ghostWriter.place(
              piece.s,
              sessions.index(piece.s),
              piece.c,
              piece.len,
            );
            if (piece === last) break;
          }
        runs++;
        texts.push(text);
        const session = sessions.index(run.s);
        const length = text.length;
        let bits = 0;
        if (length >= LONG) fields.write(length - LONG, CUT.LONG);
        if (session === backS && run.c === backEnd) bits |= BITS.RESUME;
        else if (session === prevS && run.c + length === prevC)
          bits |= BITS.BEFORE;
        else {
          if (session !== curSession) {
            bits |= BITS.SESSION;
            fields.writeSigned(session - curSession, CUT.SESSION);
          }
          const expected = ends[session] ?? 0;
          if (run.c !== expected) {
            bits |= BITS.COUNTER;
            fields.writeSigned(run.c - expected, CUT.COUNTER);
          }
        }
        curSession = session;
        ends[session] = run.c + length;
        backS = prevS;
        backEnd = prevEnd;
        prevS = session;
        prevC = run.c;
        prevEnd = run.c + length;
        let shape = bitsIndex[bits]!;
        if (shape === -1) {
          shape = bitsIndex[bits] = shapeBits.length;
          shapeBits.push(bits);
        }
        shapeColumn.push(shape * (LONG + 1) + Math.min(length, LONG));
        if (hasState) {
          const index = stateIndex(run.state);
          if (index === lastState) stateCount++;
          else {
            if (stateCount > 0) {
              stateRuns.push(stateCount);
              stateRuns.push(lastState);
            }
            lastState = index;
            stateCount = 1;
          }
        }
        run = last.next;
      }
      if (stateCount > 0) {
        stateRuns.push(stateCount);
        stateRuns.push(lastState);
      }
      flowRuns.push(runs);
    }
    const shapes = new ColumnWriter(shapeBits.length * 2, false, true);
    for (const bits of shapeBits) shapes.push(bits);
    out.push(
      flowFlags,
      flowRuns,
      shapeColumn,
      shapes,
      fields,
      nodeSessions,
      nodeClocks,
      stateRuns,
      ...ghostWriter.columns,
    );
    const stored: Json[] = [texts.join("")];
    if (states.length > 0) stored.push(states);
    return stored;
  }

  static fromJSON(json: unknown): BaseText {
    if (!isList(json)) return new BaseText();
    const [format, table, columns, ...stored] = json;
    if (format !== FORMAT)
      throw new Error(`Unsupported text format: ${JSON.stringify(format)}`);
    return BaseText.fromStored(
      stored,
      splitColumns(stringOf(columns)),
      readSessions(listOf(table)!.map(String)),
    );
  }

  static fromStored(
    stored: Json[],
    columns: string[],
    sessions: string[],
  ): BaseText {
    const store = new BaseText();
    const [text, states] = stored;
    const letters = stringOf(text);
    const table = (listOf(states) ?? [])
      .filter(isState)
      .map((state) => store._intern(state));
    const column = (field: number) => new ColumnReader(columns[field] ?? "");
    const flowFlags = column(COLUMN.FLOW_FLAGS);
    const flowRuns = column(COLUMN.FLOW_RUNS);
    const shapeColumn = column(COLUMN.SHAPE);
    const shapes = column(COLUMN.SHAPES);
    const fields = new FieldReader(columns[COLUMN.FIELDS]!);
    const nodeSessions = column(COLUMN.NODE_SESSION);
    const nodeClocks = column(COLUMN.NODE_CLOCK);
    const stateRuns = column(COLUMN.STATE_RUNS);
    const ghosts = new GhostReader(
      columns.slice(COLUMN.GHOST_PLACES),
      sessions,
      table,
      store._ghosts,
    );
    const shapeBits: number[] = [];
    while (!shapes.done) shapeBits.push(shapes.next());
    const bySession = new Map<string, Run[]>();
    const ends: number[] = [];
    let curSession = 0;
    let position = 0;
    let key: string | undefined;
    while (!flowFlags.done) {
      const flags = flowFlags.next();
      key =
        flags & FLOW.KEY
          ? joinId(sessions[nodeSessions.next()]!, nodeClocks.next())
          : nextId(key!)!;
      const flow = store._flow(key);
      ghosts.read(key, -1, -1, 1);
      let prev = flow.head;
      let stateLeft = 0;
      let state: State | undefined;
      let prevS = -1;
      let prevC = 0;
      let prevEnd = 0;
      let backS = -1;
      let backEnd = 0;
      for (let left = flowRuns.next(); left > 0; left--) {
        const code = shapeColumn.next();
        const bits = shapeBits[Math.floor(code / (LONG + 1))]!;
        let length = code % (LONG + 1);
        if (length === LONG) length += fields.read(CUT.LONG);
        let session: number;
        let c: number;
        if (bits & BITS.RESUME) {
          session = backS;
          c = backEnd;
        } else if (bits & BITS.BEFORE) {
          session = prevS;
          c = prevC - length;
        } else {
          session =
            curSession +
            (bits & BITS.SESSION ? fields.readSigned(CUT.SESSION) : 0);
          c = ends[session] ?? 0;
          if (bits & BITS.COUNTER) c += fields.readSigned(CUT.COUNTER);
        }
        curSession = session;
        ends[session] = c + length;
        backS = prevS;
        backEnd = prevEnd;
        prevS = session;
        prevC = c;
        prevEnd = c + length;
        if (flags & FLOW.STATES) {
          if (stateLeft === 0) {
            stateLeft = stateRuns.next();
            state = table[stateRuns.next() - 1];
          }
          stateLeft--;
        }
        const s = sessions[session]!;
        const anchors = ghosts.read(s, session, c, length);
        const run = new Run(
          s,
          c,
          letters.slice(position, position + length),
          state,
          flow,
        );
        run.anchors = anchors;
        position += length;
        prev.next = run;
        run.prev = prev;
        prev = run;
        const runs = bySession.get(s);
        if (runs) runs.push(run);
        else bySession.set(s, [run]);
      }
    }
    for (const [session, runs] of bySession)
      store._index.set(session, SessionRuns.from(runs));
    store._ghosts.finish(ghosts.loaded);
    return store;
  }

  // ----- test inspection ---------------------------------------------------

  protected _debugRuns(): string[][] {
    return this._sortedFlows().map((flow) => {
      const runs: string[] = [];
      for (let run = flow.head.next; run; run = run.next) runs.push(run.text);
      return runs;
    });
  }

  /** The lists by node id: the same order in every replica. */
  private _sortedFlows(): Flow[] {
    return [...this._flows.keys()].sort().map((node) => this._flows.get(node)!);
  }
}

/** Whether a reference is a node's start: `^node` or `#hash` (see `_startRef`). */
const isStart = (ref: Json | undefined): ref is string =>
  typeof ref === "string" &&
  (ref.charCodeAt(0) === 94 || ref.charCodeAt(0) === 35);

/** Whether `run`, right after `left`, only differs from it by being apart. */
const joins = (
  left: Run,
  run: { s: string; c: number; state: State | undefined },
) =>
  left.c !== -1 &&
  left.s === run.s &&
  left.c + left.len === run.c &&
  left.state === run.state;

/**
 * What of each state a ghost keeps, by rules (see `_inheritable`); `false`:
 * nothing. A state belongs to one text, so the result is that text's.
 */
const keptByRules = new WeakMap<Rules, WeakMap<State, State | false>>();

/** A letter's state as written: an object of JSON values. */
const isState = (value: Json | undefined): value is State => isRecord(value);

/**
 * The first state of letters typed between `left` and `right`: what they
 * must say of their own to have `attrs` (`null`: a key they would inherit
 * and must not have).
 */
function ownFor(
  rules: Rules | undefined,
  text: string,
  left: Element,
  right: Element | undefined,
  attrs: Record<string, Json>,
): Record<string, Json> | undefined {
  let own: Record<string, Json> | undefined;
  const cut = rules ? cutIn(text, rules.opaque) : 0;
  const leftState = left.run.c === -1 ? undefined : left.run.state;
  const inherited: Record<string, Json> = {};
  if (rules && cut > 0)
    for (const key in leftState) {
      const rule = rules.get(key);
      const value = leftState[key]!;
      const other = right?.run.state;
      if (
        rule === "origin" ||
        (rule === "both" &&
          other !== undefined &&
          Object.hasOwn(other, key) &&
          sameValue(value, other[key]!))
      )
        inherited[key] = value;
    }
  for (const key in attrs) {
    const value = attrs[key]!;
    if (value === null) continue;
    // Letters after an opaque one have their own state only: they say all.
    if (
      Object.hasOwn(inherited, key) &&
      sameValue(inherited[key]!, value) &&
      cut === text.length
    )
      continue;
    (own ??= {})[key] = value;
  }
  for (const key in inherited)
    if (!Object.hasOwn(attrs, key) || attrs[key] === null)
      (own ??= {})[key] = null;
  return own;
}

function encodeRanges(own: string, ranges: [string, number, number][]): Json {
  if (ranges.length === 1) {
    const [s, c, len] = ranges[0]!;
    return encodeRange(own, s, c, len);
  }
  const out: Json[] = [];
  for (const [s, c, len] of ranges) out.push(encodeRef(own, s, c), len);
  return out;
}

function decodeRanges(own: string, flat: Json): [string, number, number][] {
  const list = listOf(flat);
  if (!list) return [[...decodeRef(own, flat), 1]];
  const out: [string, number, number][] = [];
  for (let index = 0; index < list.length; index += 2)
    out.push([...decodeRef(own, list[index]!), Number(list[index + 1])]);
  return out;
}

const isList = (value: unknown): value is Json[] => Array.isArray(value);

/** Flags of a stored list. */
const FLOW = {
  /** Its node id is not the one right after the previous list's. */
  KEY: 1,
  /** Its runs have state (see `COLUMN.STATE_RUNS`). */
  STATES: 2,
};
/** Flags of a stored run. */
const BITS = {
  /** Its session is not the one of the run before (by how far its index is). */
  SESSION: 1,
  /** Its counter is not where its session's last run ended. */
  COUNTER: 2,
  /** It ends where the run before starts, of its session: typed before it. */
  BEFORE: 4,
  /**
   * It starts where the run before the one before ends, of its session: it
   * goes on after letters typed in the middle of it.
   */
  RESUME: 8,
  ALL: 16,
};
/** The columns of a stored text. */
const COLUMN = {
  FLOW_FLAGS: 0,
  FLOW_RUNS: 1,
  SHAPE: 2,
  SHAPES: 3,
  /** The fields of the runs one after the other (see `CUT`). */
  FIELDS: 4,
  NODE_SESSION: 5,
  NODE_CLOCK: 6,
  /** Per list with state: `count, state` for each stretch of runs. */
  STATE_RUNS: 7,
  /** The ghosts' columns (see `GhostWriter`). */
  GHOST_PLACES: 8,
};
const CUT = { LONG: 48, SESSION: 8, COUNTER: 40 };
const LONG = 16;
/** The stored format this version writes (see `toJSON`). */
const FORMAT = 20;

/**
 * The ghosts of a stored text, by their anchor, in the order of the lists:
 * a list's start, then each of its letters, is one place. Per ghost (ids of
 * one session in a row), in four columns:
 *
 * - how many places after the last anchor its anchor is (`0`: the same);
 * - its session, as the distance from the last ghost's;
 * - its counter, as the distance from the one after the ghost before it of
 *   the anchor, if of its session, else from the one after the anchor (a
 *   letter of its session: what was typed after it and deleted), else from
 *   where the last ghost of its session ended;
 * - its length, minus one;
 * - what of their state it keeps (see `Ghost.state`): an index in the
 *   states, plus one, or `0`.
 */
class GhostWriter {
  private readonly _places = new ColumnWriter(64, false, true);
  private readonly _sessions = new ColumnWriter();
  private readonly _counters = new ColumnWriter();
  private readonly _lengths = new ColumnWriter();
  private readonly _states = new ColumnWriter();
  private readonly _ends: number[] = [];
  /** The sorted counters of the anchors of each session (see `Ghosts.anchorsOf`). */
  private readonly _anchors = new Map<string, number[]>();
  /** The place of the next letter or start, and the last anchor's. */
  private _place = 0;
  private _anchor = -1;
  private _session = 0;

  constructor(
    private readonly _table: SessionTable,
    private readonly _ghosts: Ghosts,
    private readonly _stateIndex: (state: State | undefined) => number,
  ) {}

  get columns(): ColumnWriter[] {
    return [
      this._places,
      this._sessions,
      this._counters,
      this._lengths,
      this._states,
    ];
  }

  /**
   * The ghosts anchored at the next `length` places: letters of `as` (index
   * `session`) from counter `c`, or the start of list `as` (`-1`, `-1`).
   */
  place(as: string, session: number, c: number, length: number): void {
    let anchors = this._anchors.get(as);
    if (!anchors) this._anchors.set(as, (anchors = this._ghosts.anchorsOf(as)));
    for (let at = lowerBound(anchors, c); at < anchors.length; at++) {
      const ac = anchors[at]!;
      if (ac >= c + length) break;
      this._group(this._ghosts.at(as, ac), session, this._place + ac - c, ac);
    }
    this._place += length;
  }

  private _group(ghosts: Ghost[], session: number, place: number, ac: number) {
    let last = -1;
    let lastEnd = 0;
    for (let at = 0; at < ghosts.length; ) {
      const ghost = ghosts[at]!;
      // Ids of one session in a row, with one state, are written once.
      let len = ghost.len;
      for (
        let next = ghosts[++at];
        next?.s === ghost.s &&
        next.c === ghost.c + len &&
        next.state === ghost.state;
        next = ghosts[++at]
      )
        len += next.len;
      this._places.push(place - this._anchor);
      this._anchor = place;
      const index = this._table.index(ghost.s);
      this._sessions.pushSigned(index - this._session);
      this._session = index;
      const expected =
        index === last
          ? lastEnd
          : index === session
            ? ac + 1
            : (this._ends[index] ?? 0);
      this._counters.pushSigned(ghost.c - expected);
      this._lengths.push(len - 1);
      this._states.push(this._stateIndex(ghost.state));
      last = index;
      lastEnd = this._ends[index] = ghost.c + len;
    }
  }
}

/** The first index of sorted `values` whose value is not below `value`. */
function lowerBound(values: number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid]! < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Reads the ghosts `GhostWriter` wrote, place by place. */
class GhostReader {
  private readonly _places: ColumnReader;
  private readonly _sessions: ColumnReader;
  private readonly _counters: ColumnReader;
  private readonly _lengths: ColumnReader;
  private readonly _states: ColumnReader;
  private readonly _ends: number[] = [];
  /** The ghosts read so far, by session (see `Ghosts.finish`). */
  readonly loaded = new Map<string, Ghost[]>();
  /** The place of the next letter or start, and the next anchor's. */
  private _place = 0;
  private _anchor: number;
  private _session = 0;

  constructor(
    columns: string[],
    private readonly _table: string[],
    private readonly _stateTable: (State | undefined)[],
    private readonly _ghosts: Ghosts,
  ) {
    const column = (field: number) => new ColumnReader(columns[field] ?? "");
    this._places = column(0);
    this._sessions = column(1);
    this._counters = column(2);
    this._lengths = column(3);
    this._states = column(4);
    this._anchor = this._places.done ? Infinity : this._places.next() - 1;
  }

  /**
   * The ghosts anchored at the next `length` letters, of `s` (index
   * `session`) from counter `c`, or at the start of list `s` (`-1`, `-1`).
   * Whether there are some.
   */
  read(s: string, session: number, c: number, length: number): boolean {
    const end = this._place + length;
    const anchors = this._anchor < end;
    while (this._anchor < end) {
      const ac = c === -1 ? -1 : c + this._anchor - this._place;
      let last = -1;
      let lastEnd = 0;
      for (let same = true; same; ) {
        const index = this._session + this._sessions.nextSigned();
        this._session = index;
        const expected =
          index === last
            ? lastEnd
            : index === session
              ? ac + 1
              : (this._ends[index] ?? 0);
        const ghostC = expected + this._counters.nextSigned();
        const len = this._lengths.next() + 1;
        last = index;
        lastEnd = this._ends[index] = ghostC + len;
        const state = this._states.next();
        this._ghosts.load(
          {
            s: this._table[index]!,
            c: ghostC,
            len,
            as: s,
            ac,
            state: state === 0 ? undefined : this._stateTable[state - 1],
          },
          this.loaded,
        );
        if (this._places.done) {
          this._anchor = Infinity;
          break;
        }
        const step = this._places.next();
        same = step === 0;
        this._anchor += step;
      }
    }
    this._place = end;
    return anchors;
  }
}
