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
  decodeRef,
  encodeRange,
  encodeRef,
  isHighSurrogate,
  isLowSurrogate,
  listOf,
  nextId,
  pushRange,
  SessionRuns,
  stringOf,
  TextEngine,
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
 *   `(session, counter)`; consecutive ids of one session are one run.
 * - Deleting removes letters for good: no tombstones. What is left of them
 *   is a ghost (see `Ghosts`): their ids and the letter before them.
 * - An insert names the letters on both sides. The left one exists: right
 *   after it. Else the right one exists: right before it. Else it goes
 *   where the left one was deleted: right after the anchor of its ghost.
 *   Only after an insert that was lost (it named a node not here) can it be
 *   lost too.
 * - An undo of a delete inserts the letters again, with their ids. Their
 *   ids: a later undo (of the insert that made them) names them, and two
 *   undos of one delete bring them back once.
 */

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
    readonly flow: Flow,
  ) {}

  get len(): number {
    return this.text.length;
  }
}

/** The list of one node: its root (a run without letters), then its letters. */
class Flow {
  readonly head: Run;
  constructor(readonly node: string) {
    this.head = new Run(node, -1, "", this);
  }
}

/** A letter, possibly in the middle of a run; a node's root is its start. */
type Element = { run: Run; off: number };

const TAG_DELETE = 1;
const TAG_RESTORE = 4;

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

  // ----- the list ----------------------------------------------------------

  private _after({ run, off }: Element): Element | undefined {
    if (off + 1 < run.len) return { run, off: off + 1 };
    return run.next && { run: run.next, off: 0 };
  }

  private _linkAfter(target: Run, run: Run): void {
    this._positions.linked(target, run);
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

  /** `insertLetters`, at a visible index. */
  insert(doc: Doc, node: string, index: number, text: string): void {
    if (text.length === 0) return;
    const flow = this._flow(node);
    const left = this._leftOf(flow, this._boundary(flow, index));
    const right = this._after(left);
    const [s, c] = this._mint(doc, text.length);
    const payload: EditOperation = [3, s, c, text];
    if (left.run.c === -1) payload.push(this._startRef(doc, node));
    else this._neighbours(doc, payload, s, c, left, right);
    const inverse = this._insert(doc, s, c, text, left);
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

  /** Deletes a visible range: its letters leave the list. */
  delete(doc: Doc, node: string, index: number, length: number): void {
    const ranges = this._ranges(this._flow(node), index, index + length);
    if (ranges.length === 0) return;
    const [s, c] = this._mint(doc, 0);
    const payload: EditOperation = [
      3,
      TAG_DELETE,
      s,
      c,
      encodeRanges(s, ranges),
    ];
    // Its letters are here: it deletes them.
    this._record(doc, payload, this.apply(doc, payload)!);
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
    let text = stringOf(payload[3]);
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
    }
    if (!at) return undefined;
    return this._insert(doc, s, c, text, at);
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

  /** Inserts letters right after `left`. */
  private _insert(
    doc: Doc,
    s: string,
    c: number,
    text: string,
    left: Element,
  ): EditOperation {
    const flow = left.run.flow;
    const target = left.run;
    if (left.off < target.len - 1) this._split(target, left.off + 1);
    if (target.c !== -1 && target.s === s && target.c + target.len === c) {
      // Typing: the letters go on the run before them.
      target.text += text;
      this._positions.changed(target);
    } else {
      const run = new Run(s, c, text, flow);
      this._indexRun(run);
      this._linkAfter(target, run);
    }
    this._report(doc, flow.node);
    return [3, TAG_DELETE, s, c, encodeRange(s, s, c, text.length)];
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
    let text = "";
    const ids: [string, number, number][] = [];
    for (const run of removed) {
      text += run.text;
      pushRange(ids, run.s, run.c, run.len);
      // Its ghost: after the letter before it, which stays.
      const before = run.prev!;
      if (before.c === -1)
        this._ghosts.add(
          run.s,
          run.c,
          run.len,
          before.flow.node,
          -1,
          run.anchors,
        );
      else {
        this._ghosts.add(
          run.s,
          run.c,
          run.len,
          before.s,
          before.c + before.len - 1,
          run.anchors,
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
      // The place of the letters' state, which they have none of.
      0,
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
    // What says nothing at the end is left out: `-1`s, then the `0`.
    if (inverse[8] === -1) {
      inverse.pop();
      if (inverse[7] === -1) inverse.splice(6);
    }
    return inverse;
  }

  /**
   * `[3, 4, s, c, text, ids, 0?, right?, left?]`: letters a delete took,
   * back with their `ids` (ranges, in order), before `right` or else after
   * `left`: what was typed where they were since goes before them. The `0`
   * is the place of the letters' state, which they have none of.
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
    const back: [string, number, number][] = [];
    let from = 0;
    for (const [rs, rc, length] of ranges) {
      this._checkSession(doc, rs, rc + length);
      for (let k = 0; k < length; k++, from++) {
        const found = this._find(rs, rc + k);
        if (found) {
          at = found;
          continue;
        }
        at = this._place(at, rs, rc + k, text[from]!);
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
  private _place(at: Element, s: string, c: number, letter: string): Element {
    const target = at.run;
    if (at.off < target.len - 1) this._split(target, at.off + 1);
    if (target.c !== -1 && joins(target, { s, c })) {
      target.text += letter;
      this._positions.changed(target);
      return { run: target, off: target.len - 1 };
    }
    const run = new Run(s, c, letter, target.flow);
    this._indexRun(run);
    this._linkAfter(target, run);
    return { run, off: 0 };
  }

  // ----- change reporting --------------------------------------------------

  private _report(doc: Doc, node: string): void {
    const diff = doc["_diff"];
    if (doc.getNodeById(node) && !diff.inserted.has(node))
      diff.updated.add(node);
  }

  // ----- serialization -----------------------------------------------------

  /** `[20, sessions, text, columns]` (see `toStored`). */
  toJSON(): Json {
    const sessions = new SessionTable();
    const columns: { encode(): string }[] = [];
    const stored = this.toStored(sessions, columns);
    if (stored === 0) return 0;
    return [FORMAT, sessions.table, joinColumns(columns), ...stored];
  }

  /**
   * `[text]`, or `0` when there is no text, and its columns in `out`:
   *
   * - `text`: the letters of every list, in order.
   * - Per list: whether its node is not the one after the previous list's
   *   (then its id), and its number of runs.
   * - Per run (runs that only differ by being apart are one): its shape
   *   (length and flags), and only the fields the run before does not imply:
   *   its session, its counter.
   * - The ghosts (see `Ghosts`), by their anchor, in the order of the lists
   *   (a list's start, then each letter, is one place): see `GhostWriter`.
   */
  toStored(sessions: SessionTable, out: { encode(): string }[]): Json[] | 0 {
    const ghosts = this._ghosts;
    const flows = this._sortedFlows().filter(
      (flow) => flow.head.next !== undefined || ghosts.hasStart(flow.node),
    );
    if (flows.length === 0) return 0;
    const ghostWriter = new GhostWriter(sessions, ghosts);
    const flowFlags = new ColumnWriter(flows.length, false, true);
    const flowRuns = new ColumnWriter(flows.length);
    const shapeColumn = new ColumnWriter(1024);
    const nodeSessions = new ColumnWriter(flows.length);
    const nodeClocks = new ColumnWriter(flows.length);
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
      flowFlags.push(flags);
      let runs = 0;
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
        run = last.next;
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
      // The place of the letters' state, which they have none of.
      new ColumnWriter(),
      ...ghostWriter.columns,
    );
    return [texts.join("")];
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
    // Letters with state: what a later version stores.
    if (stored.length > 1)
      throw new Error(
        "The stored text has letters with state, which this version does not read.",
      );
    const store = new BaseText();
    const letters = stringOf(stored[0]);
    const column = (field: number) => new ColumnReader(columns[field] ?? "");
    const flowFlags = column(COLUMN.FLOW_FLAGS);
    const flowRuns = column(COLUMN.FLOW_RUNS);
    const shapeColumn = column(COLUMN.SHAPE);
    const shapes = column(COLUMN.SHAPES);
    const fields = new FieldReader(columns[COLUMN.FIELDS]!);
    const nodeSessions = column(COLUMN.NODE_SESSION);
    const nodeClocks = column(COLUMN.NODE_CLOCK);
    const ghosts = new GhostReader(
      columns.slice(COLUMN.GHOST_PLACES),
      sessions,
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
        const s = sessions[session]!;
        const anchors = ghosts.read(s, session, c, length);
        const run = new Run(
          s,
          c,
          letters.slice(position, position + length),
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
const joins = (left: Run, run: { s: string; c: number }) =>
  left.c !== -1 && left.s === run.s && left.c + left.len === run.c;

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
  /** The place of the letters' state, which they have none of: empty. */
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
 * - its length, minus one.
 */
class GhostWriter {
  private readonly _places = new ColumnWriter(64, false, true);
  private readonly _sessions = new ColumnWriter();
  private readonly _counters = new ColumnWriter();
  private readonly _lengths = new ColumnWriter();
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
  ) {}

  get columns(): ColumnWriter[] {
    return [this._places, this._sessions, this._counters, this._lengths];
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
      // Ids of one session in a row are written once.
      let len = ghost.len;
      for (
        let next = ghosts[++at];
        next?.s === ghost.s && next.c === ghost.c + len;
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
    private readonly _ghosts: Ghosts,
  ) {
    const column = (field: number) => new ColumnReader(columns[field] ?? "");
    this._places = column(0);
    this._sessions = column(1);
    this._counters = column(2);
    this._lengths = column(3);
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
        this._ghosts.load(
          { s: this._table[index]!, c: ghostC, len, as: s, ac },
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
