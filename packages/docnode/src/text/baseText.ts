import type { Doc } from "../main.js";
import type { Json, StoredLetters } from "../types.js";
import type { EditOperation } from "../operations.js";
import { lastDot, numberToBase64 } from "../idGenerator.js";
import { isList } from "../utils.js";
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
import { Ghosts, type Ghost } from "./ghosts.js";
import { TreePositions, type Item, type Leaf } from "./positions.js";

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

/** A letter's state: never changed in place, runs share it (see `#intern`). */
type State = Readonly<Record<string, Json>>;

class Run implements Item<Run> {
  prev: Run | undefined;
  next: Run | undefined;
  leaf: Leaf<Run> | undefined;
  vis = 0;
  /** Whether a ghost may be anchored at one of its letters (see `Ghosts`). */
  anchors = false;
  /**
   * `text.length`, kept with it: read on every lookup. Every letter of the
   * list is visible (see `Item`): deleted ones are gone.
   */
  len: number;

  constructor(
    readonly s: string,
    public c: number,
    public text: string,
    public state: State | undefined,
    readonly flow: Flow,
  ) {
    this.len = text.length;
  }
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
 * `#startRef`). Ids of a session are short on the wire.
 */
const hashable = (id: string) => id.length > 6 && lastDot(id) === -1;

function decodeRanges(own: string, flat: Json): [string, number, number][] {
  const list = listOf(flat);
  if (!list) return [[...decodeRef(own, flat), 1]];
  const out: [string, number, number][] = [];
  for (let index = 0; index < list.length; index += 2)
    out.push([...decodeRef(own, list[index]!), Number(list[index + 1])]);
  return out;
}

/** A letter's reference from an operation of `own` (see `encodeRef`). */
const refTo = (own: string, { run, off }: Element) =>
  encodeRef(own, run.s, run.c + off);

export class BaseText extends TextEngine {
  #session: string | undefined;
  #counter = 0;
  #renewals = 0;
  #doc: Doc | undefined;
  #index = new Map<string, SessionRuns<Run>>();
  #flows = new Map<string, Flow>();
  /** The hash of each node id hashed so far (see `#startRef`). */
  #hashes = new Map<string, string>();
  /** Each distinct state, by its JSON (see `#intern`). */
  #states = new Map<string, State>();
  /**
   * The transaction being written (see `Doc._commits`), and the first counter
   * it minted: letters of this session from it on came in the same batch.
   */
  #tx = -1;
  #txStart = 0;
  #positions = new TreePositions<Run>();
  /** Where deleted letters were (see `Ghosts`). */
  #ghosts = new Ghosts();

  /** The first and the last letter of `ranges` still here. */
  #ends(
    ranges: [string, number, number][],
  ): [Element | undefined, Element | undefined] {
    let first: Element | undefined;
    let last: Element | undefined;
    for (const [rs, rc, len] of ranges) {
      for (let k = 0; k < len && !first; k++) first = this.#find(rs, rc + k);
      if (first) break;
    }
    for (let at = ranges.length - 1; at >= 0 && !last; at--) {
      const [rs, rc, len] = ranges[at]!;
      for (let k = len - 1; k >= 0 && !last; k--) last = this.#find(rs, rc + k);
    }
    return [first, last];
  }

  /** Cuts `run` at `offset`: the new run after it. */
  #split(run: Run, offset: number): Run {
    const tail = new Run(
      run.s,
      run.c + offset,
      run.text.slice(offset),
      run.state,
      run.flow,
    );
    tail.anchors = run.anchors;
    run.text = run.text.slice(0, offset);
    run.len = offset;
    this.#positions.changed(run);
    this.#indexRun(tail);
    this.#linkAfter(run, tail);
    return tail;
  }

  /** What an undo of the history applies: the operation as it is. */
  prepareUndo(_doc: Doc, undo: EditOperation): EditOperation {
    return undo;
  }

  /**
   * The start of a node's text: `^` for the root's, which every replica has,
   * `#` and the shortest prefix of the hash of its id that no other node
   * has here (see `hashable`), or `^node`.
   */
  #startRef(doc: Doc, node: string): string {
    if (node === doc.root.id) return "^";
    if (!hashable(node)) return `^${node}`;
    const hash = this.#hash(node);
    // How many first digits it shares with the closest other one.
    let shared = 0;
    this.#eachHashable(doc, (id) => {
      if (id === node) return;
      const other = this.#hash(id);
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
  #start(doc: Doc, ref: string): Element | undefined {
    let node: string | undefined = ref.slice(1) || doc.root.id;
    if (ref.charCodeAt(0) === 35) {
      let found: string | undefined;
      this.#eachHashable(doc, (id) => {
        if (
          this.#hash(id).startsWith(node!) &&
          (found === undefined || id < found)
        )
          found = id;
      });
      node = found;
    }
    return node === undefined
      ? undefined
      : { run: this.#flow(node).head, off: 0 };
  }

  /**
   * `index` clamped to the text and moved off the middle of a surrogate pair,
   * and the letter right before it (the node's root for 0).
   */
  #boundary(flow: Flow, index: number): [number, Element] {
    // Before the index of positions is needed: typing at the start of every
    // text of many documents builds none.
    if (index <= 0) return [0, { run: flow.head, off: 0 }];
    const length = this.#positions.length(flow.head);
    if (index > length) index = length;
    const left = this.#positions.seek(flow.head, index - 1);
    const right = this.#after(left)!;
    return index < length &&
      isHighSurrogate(left.run.text.charCodeAt(left.off)) &&
      isLowSurrogate(right.run.text.charCodeAt(right.off))
      ? [index + 1, right]
      : [index, left];
  }

  lengthOf(node: string): number {
    const flow = this.#flows.get(node);
    return flow ? this.#positions.length(flow.head) : 0;
  }

  spansOf(node: string): TextSpan[] {
    const out: TextSpan[] = [];
    const flow = this.#flows.get(node);
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

  #flow(node: string): Flow {
    let flow = this.#flows.get(node);
    if (!flow) this.#flows.set(node, (flow = new Flow(node)));
    return flow;
  }

  /** The lists by node id: the same order in every replica. */
  #sortedFlows(): Flow[] {
    return [...this.#flows.keys()].sort().map((node) => this.#flows.get(node)!);
  }

  // ----- serialization -----------------------------------------------------

  /** `[20, sessions, text, columns, states?]` (see `toStored`). */
  toJSON(): Json {
    const sessions = new SessionTable();
    const columns: { encode(): string }[] = [];
    // Without a root, every list's node is written.
    const stored = this.toStored(sessions, columns, "");
    if (stored === 0) return 0;
    return [FORMAT, sessions.table, joinColumns(columns), ...stored];
  }

  // ----- reading ---------------------------------------------------------

  textOf(node: string): string {
    let text = "";
    const flow = this.#flows.get(node);
    if (!flow) return text;
    for (let run = flow.head.next; run; run = run.next) text += run.text;
    return text;
  }

  /** The run that starts at `element`, cut from its run if needed. */
  #startingAt({ run, off }: Element): Run {
    return off === 0 ? run : this.#split(run, off);
  }

  /**
   * Calls `visit` with each id `#` could name: the nodes of the tree, and
   * those whose text is not empty (the same in every replica that applied
   * the same operations, also after a reload).
   */
  #eachHashable(doc: Doc, visit: (id: string) => void): void {
    const nodes = doc["_nodeMap"];
    for (const id of nodes.keys()) if (hashable(id)) visit(id);
    for (const [id, flow] of this.#flows)
      if (flow.head.next && hashable(id) && !nodes.has(id)) visit(id);
  }

  #hash(id: string): string {
    let hash = this.#hashes.get(id);
    if (hash === undefined) this.#hashes.set(id, (hash = idHash(id)));
    return hash;
  }

  // ----- change reporting --------------------------------------------------

  #report(doc: Doc, node: string): void {
    const diff = doc["_diff"];
    if (doc.getNodeById(node) && !diff.inserted.has(node))
      diff.updated.add(node);
  }

  #indexRun(run: Run): void {
    let runs = this.#index.get(run.s);
    if (!runs) this.#index.set(run.s, (runs = new SessionRuns<Run>()));
    runs.add(run);
  }

  /** The rules of a node's type while it is in the document. */
  #rules(flow: Flow): Rules | undefined {
    const rules = rulesOfNode(this.#doc, flow.node);
    return rules === false ? undefined : rules;
  }

  bind(doc: Doc): void {
    this.#doc = doc;
  }

  #unlink(run: Run): void {
    this.#positions.removed(run);
    run.prev!.next = run.next;
    if (run.next) run.next.prev = run.prev;
    const runs = this.#index.get(run.s)!;
    runs.remove(run);
    // A session without letters is no more: its runs are never empty.
    if (runs.empty) this.#index.delete(run.s);
  }

  /** Joins `run` with the runs around it it only differs from by being apart. */
  #join(run: Run): void {
    while (run.prev && joins(run.prev, run)) run = run.prev;
    while (run.next && joins(run, run.next)) {
      const next = run.next;
      this.#unlink(next);
      run.text += next.text;
      run.len += next.len;
      if (next.anchors) run.anchors = true;
      this.#positions.changed(run);
    }
  }

  // ----- local operations ---------------------------------------------------

  #record(doc: Doc, operation: EditOperation, inverse: EditOperation): void {
    doc["_operations"][0].push(operation);
    doc["_inverseOperations"][0].push(inverse);
    doc["_hasEdits"] = true;
  }

  #linkAfter(target: Run, run: Run): void {
    this.#positions.linked(target, run, true);
    const next = target.next;
    target.next = run;
    run.prev = target;
    run.next = next;
    if (next) next.prev = run;
  }

  letterAt(node: string, index: number): string | undefined {
    const flow = this.#flows.get(node);
    if (!flow || index < 0 || index >= this.#positions.length(flow.head))
      return undefined;
    const { run, off } = this.#positions.seek(flow.head, index);
    return `${run.s}:${run.c + off}`;
  }

  /**
   * What of `state` a letter typed next to it can inherit (see `Inherit`):
   * the keys with a rule. A ghost keeps it (see `Ghost.state`).
   */
  #inheritable(
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
      kept = some === undefined ? false : this.#intern(some)!;
      cache.set(state, kept);
    }
    return kept === false ? undefined : kept;
  }

  /** One object per distinct state, with sorted keys; none for `{}`. */
  #intern(values: State | undefined): State | undefined {
    if (!values) return undefined;
    const keys = Object.keys(values).sort();
    if (keys.length === 0) return undefined;
    const sorted: Record<string, Json> = {};
    for (const key of keys) sorted[key] = values[key]!;
    const json = JSON.stringify(sorted);
    let state = this.#states.get(json);
    if (!state) this.#states.set(json, (state = sorted));
    return state;
  }

  // ----- identity --------------------------------------------------------

  #mint(doc: Doc, length: number): [string, number] {
    if (
      this.#session === undefined ||
      this.#renewals !== doc["_sessionRenewals"]
    ) {
      const id = doc["_nodeIdGenerator"](doc);
      const dot = lastDot(id);
      this.#session = dot === -1 ? id : id.slice(0, dot);
      this.#renewals = doc["_sessionRenewals"];
      // A custom generator names the same session after a reload: its
      // counters go on after the letters the document holds.
      this.#counter = Math.max(
        this.#index.get(this.#session)?.end() ?? 0,
        this.#ghosts.end(this.#session),
      );
    }
    const counter = this.#counter;
    if (this.#tx !== doc["_commits"]) {
      this.#tx = doc["_commits"];
      this.#txStart = counter;
    }
    this.#counter += length;
    return [this.#session, counter];
  }

  // ----- the list ----------------------------------------------------------

  #after({ run, off }: Element): Element | undefined {
    if (off + 1 < run.len) return { run, off: off + 1 };
    return run.next && { run: run.next, off: 0 };
  }

  /**
   * Whether `element` was inserted earlier in the batch being written: the
   * server applies a batch as a whole, so nobody deletes it before.
   */
  #local(doc: Doc, { run, off }: Element): boolean {
    return (
      run.s === this.#session &&
      run.c + off >= this.#txStart &&
      this.#tx === doc["_commits"]
    );
  }

  /** Letters of this replica's session it did not write: a copy's (see `NodeIds`). */
  #checkSession(doc: Doc, s: string, end: number): void {
    if (s === this.#session && end > this.#counter) doc["_renewSession"]();
  }

  /** The letter (or start) right before `element`. */
  #before({ run, off }: Element): Element {
    if (off > 0) return { run, off: off - 1 };
    const prev = run.prev!;
    return { run: prev, off: Math.max(prev.len - 1, 0) };
  }

  #find(s: string, c: number): Element | undefined {
    const run = this.#index.get(s)?.find(c);
    return run && { run, off: c - run.c };
  }

  /** The anchor of the ghost of deleted letter `(s, c)`, if it is one. */
  #anchorOf(s: string, c: number): Element | undefined {
    const ghost = this.#ghosts.find(s, c);
    if (!ghost) return undefined;
    return ghost.ac === -1
      ? { run: this.#flow(ghost.as).head, off: 0 }
      : this.#find(ghost.as, ghost.ac);
  }

  #applyInsert(
    doc: Doc,
    payload: EditOperation,
    s: string,
  ): EditOperation | undefined {
    let c = Number(payload[2]);
    const content = payload[3];
    let text = lettersOf(content);
    this.#checkSession(doc, s, c + text.length);
    // Applied already (a batch delivered twice, maybe fused with the next
    // ones): the known prefix is skipped, the rest follows its last letter.
    // Ids that are ghosts were applied, and deleted since.
    let known = 0;
    while (known < text.length) {
      const found = this.#find(s, c + known);
      if (found) known += found.run.len - found.off;
      else {
        const ghost = this.#ghosts.find(s, c + known);
        if (!ghost) break;
        known = ghost.c + ghost.len - c;
      }
    }
    if (known >= text.length) return undefined;
    // A later letter of it is here (the first ones were deleted since):
    // never two letters with one id.
    if (
      this.#index.get(s)?.overlaps(c + known, text.length - known) ||
      this.#ghosts.overlaps(s, c + known, text.length - known)
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
      at = this.#find(s, c - 1);
      next = at && this.#after(at);
    } else if (isStart(right)) {
      at = this.#start(doc, right);
      next = at && this.#after(at);
    } else {
      if (typeof right === "number" && right < 0) {
        right = -right;
        left = 0;
      }
      const r: [string, number] =
        right === undefined || right === 0 ? ["", -1] : decodeRef(s, right);
      const rs = r[0];
      const rc = r[1];
      const l: [string, number] =
        left === undefined
          ? [s, c - 1]
          : left === 0
            ? [rs, rc - 1]
            : left === -1
              ? ["", -1]
              : decodeRef(s, left);
      const ls = l[0];
      const lc = l[1];
      at = this.#find(ls, lc);
      next = at ? this.#after(at) : this.#find(rs, rc);
      // Right before `next`: after the letter before it.
      if (!at && next) at = this.#before(next);
      // Both deleted: where the left one was.
      if (!at) {
        at = this.#anchorOf(ls, lc);
        next = at && this.#after(at);
      }
      around = this.#ghostStates(at, next, ls, lc, rs, rc);
    }
    if (!at) return undefined;
    const flow = at.run.flow;
    return this.#insert(
      doc,
      s,
      c,
      text,
      stateOfContent(content),
      this.#rules(flow),
      at,
      next,
      around,
    );
  }

  // ----- applying operations ---------------------------------------------

  apply(doc: Doc, payload: EditOperation): EditOperation | undefined {
    const tag = payload[1];
    if (typeof tag === "string") return this.#applyInsert(doc, payload, tag);
    const s = stringOf(payload[2]);
    const c = Number(payload[3]);
    switch (tag) {
      case TAG_DELETE:
        return this.#applyDelete(doc, s, c, decodeRanges(s, payload[4]!));
      case TAG_RESTORE:
        return this.#applyRestore(doc, payload, s, c);
      case TAG_STATE:
        return this.#applyState(doc, payload, s, c);
      case TAG_FORMAT:
        return this.#applyFormat(doc, payload, s, c);
      default:
        return undefined;
    }
  }

  /** A deleted letter is where its ghost is: right after its anchor. */
  indexOfLetter(node: string, letter: string): number | undefined {
    const flow = this.#flows.get(node);
    const parts = /^(.*):(\d+)$/s.exec(letter);
    if (!flow || !parts) return undefined;
    const s = parts[1]!;
    const c = Number(parts[2]);
    const found = this.#find(s, c) ?? this.#anchorOf(s, c);
    if (found?.run.flow !== flow) return undefined;
    if (found.run.c === -1) return 0;
    const index = this.#positions.before(flow.head, found.run) + found.off;
    return this.#find(s, c) ? index : index + 1;
  }

  #commit(doc: Doc, payload: EditOperation): void {
    const inverse = this.apply(doc, payload);
    if (inverse) this.#record(doc, payload, inverse);
  }

  /**
   * `key` is `value` on letters `[from, to)` of `run`, cut from it if
   * needed; what they had goes to `old`.
   */
  #setState(
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
    const piece = from > 0 ? this.#split(run, from) : run;
    if (to - from < piece.len) this.#split(piece, to - from);
    const index = JSON.stringify(was);
    let entry = old.get(index);
    if (!entry) old.set(index, (entry = [was, []]));
    pushRange(entry[1], piece.s, piece.c, piece.len);
    const next: Record<string, Json> = {};
    const state = piece.state;
    if (state)
      for (const other in state) if (other !== key) next[other] = state[other]!;
    if (value !== null) next[key] = value;
    piece.state = this.#intern(next);
    touched.push(piece);
  }

  /**
   * What letters typed between `(ls, lc)` and `(rs, rc)` inherit from them,
   * when one of them is a ghost: its state, as if it were still there
   * (see `Ghost.state`). Undefined when both are where the insert lands.
   */
  #ghostStates(
    at: Element | undefined,
    next: Element | undefined,
    ls: string,
    lc: number,
    rs: string,
    rc: number,
  ): [State | undefined, State | undefined] | undefined {
    if (!at || this.#ghosts.empty) return undefined;
    const left = at.run.c === -1 ? undefined : at.run.state;
    const right = next?.run.state;
    const leftGhost =
      at.run.s === ls && at.run.c + at.off === lc
        ? undefined
        : this.#ghosts.find(ls, lc);
    const rightGhost =
      rc === -1 || (next?.run.s === rs && next.run.c + next.off === rc)
        ? undefined
        : this.#ghosts.find(rs, rc);
    if (!leftGhost && !rightGhost) return undefined;
    return [
      leftGhost ? leftGhost.state : left,
      rightGhost ? rightGhost.state : right,
    ];
  }

  /**
   * The neighbours of an insert of `[3, s, c, content]` (see the format):
   * only what the receiver needs to find `left`, or `right` if it is gone.
   */
  #neighbours(
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
      if (rightRef !== 0 && !this.#local(doc, left)) payload.push(rightRef);
    } else if (right?.run.s === ls && right.run.c + right.off === lc + 1) {
      // The left one is the id before the right one: the sign says so.
      if (typeof rightRef === "number") payload.push(-rightRef);
      else payload.push(rightRef, 0);
    } else if (this.#local(doc, left)) payload.push(0, encodeRef(s, ls, lc));
    else if (right && this.#local(doc, right)) payload.push(rightRef, -1);
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
    const flow = this.#flow(node);
    const ranges = this.#ranges(flow, from, to);
    if (ranges.length === 0) return;
    const [s, c] = this.#mint(doc, 0);
    const origin = this.#rules(flow)?.get(key) === "origin";
    const payload: EditOperation = [
      3,
      origin ? TAG_FORMAT : TAG_STATE,
      s,
      c,
      key,
      encodeRanges(s, ranges),
    ];
    if (!origin) {
      if (value !== null) payload.push(value);
    } else {
      // A key letters inherit from the one before: the letter after the
      // range too, so that what others type right after it goes with it.
      payload.push(value);
      const [end] = this.#boundary(flow, to);
      const [ls, lc, len] = ranges.at(-1)!;
      if (end >= this.#positions.length(flow.head)) payload.push(0);
      else {
        const after = this.#positions.seek(flow.head, end);
        if (after.run.s !== ls || after.run.c + after.off !== lc + len)
          payload.push(refTo(s, after));
      }
    }
    this.#commit(doc, payload);
  }

  /** Deletes a visible range: its letters leave the list. */
  delete(doc: Doc, node: string, index: number, length: number): void {
    const ranges = this.#ranges(this.#flow(node), index, index + length);
    if (ranges.length === 0) return;
    const [s, c] = this.#mint(doc, 0);
    this.#commit(doc, [3, TAG_DELETE, s, c, encodeRanges(s, ranges)]);
  }

  /** The letters from `from` to `to` (visible indexes), as id ranges. */
  #ranges(flow: Flow, from: number, to: number) {
    const ranges: [string, number, number][] = [];
    [from] = this.#boundary(flow, from);
    [to] = this.#boundary(flow, to);
    if (to <= from) return ranges;
    let { run, off } = this.#positions.seek(flow.head, from);
    for (let left = to - from; left > 0; run = run.next!, off = 0) {
      const take = Math.min(run.len - off, left);
      pushRange(ranges, run.s, run.c + off, take);
      left -= take;
    }
    return ranges;
  }

  /** `key` is `value` from `first` to `last`, and on what is between them. */
  #setBetween(
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
      this.#setState(run, from, to, key, value, old, touched);
      run = end ? undefined : after;
    }
  }

  /**
   * Puts `letters` (ids from `(s, c)`) right after `at`, on the run of `at`
   * when they go on it (typing). Returns where the last one is.
   */
  #place(
    at: Element,
    s: string,
    c: number,
    letters: string,
    state: State | undefined,
  ): Element {
    const target = at.run;
    if (at.off < target.len - 1) this.#split(target, at.off + 1);
    if (joins(target, { s, c, state })) {
      target.text += letters;
      target.len += letters.length;
      this.#positions.changed(target);
      return { run: target, off: target.len - 1 };
    }
    const run = new Run(s, c, letters, state, target.flow);
    this.#indexRun(run);
    this.#linkAfter(target, run);
    return { run, off: run.len - 1 };
  }

  /**
   * Inserts letters right after `left` (and before `right`, the element
   * after it), with what they inherit from both copied into their state:
   * the letters before the first opaque one (see `Rules.opaque`).
   */
  #insert(
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
    let at = left;
    // `cut` is 0 without rules: nothing to inherit.
    if (cut > 0) {
      const [before, after] = around ?? [
        left.run.c === -1 ? undefined : left.run.state,
        right?.run.state,
      ];
      at = this.#place(
        at,
        s,
        c,
        text.slice(0, cut),
        this.#stateFor(own, before, after, rules),
      );
    }
    if (cut < text.length)
      this.#place(at, s, c + cut, text.slice(cut), this.#stateFor(own));
    this.#report(doc, flow.node);
    return [3, TAG_DELETE, s, c, encodeRange(s, s, c, text.length)];
  }

  /**
   * The state of letters with `own` state typed between letters with `left`
   * and `right` state: what they inherit (see `Inherit`) and their own
   * (`null`: a key they do not take). Without `left`, their own only.
   */
  #stateFor(
    own: Record<string, Json> | undefined,
    left?: State,
    right?: State,
    rules?: Rules,
  ): State | undefined {
    let state: Record<string, Json> | undefined;
    // While every key of `left` goes on and there is no own state, it is
    // `left` itself.
    let same = !own;
    for (const key in left) {
      const value = left[key]!;
      // Letters with state to inherit have rules (see `#insert`).
      const rule = rules!.get(key);
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
    return same ? left : this.#intern(state);
  }

  /**
   * The first state of letters typed between `left` and `right`: what they
   * must say of their own to have `attrs` (`null`: a key they would inherit
   * and must not have).
   */
  #ownFor(
    rules: Rules | undefined,
    text: string,
    left: Element,
    right: Element | undefined,
    attrs: Record<string, Json>,
  ): Record<string, Json> | undefined {
    let own: Record<string, Json> | undefined;
    const cut = rules ? cutIn(text, rules.opaque) : 0;
    const inherited: State =
      (cut > 0
        ? this.#stateFor(
            undefined,
            left.run.c === -1 ? undefined : left.run.state,
            right?.run.state,
            rules,
          )
        : undefined) ?? {};
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

  /** Reports the runs `touched` and joins them: the inverse, from `old`. */
  #stateDone(
    doc: Doc,
    s: string,
    c: number,
    key: string,
    old: OldValues,
    touched: Run[],
  ): EditOperation | undefined {
    if (touched.length === 0) return undefined;
    for (const run of touched) {
      this.#report(doc, run.flow.node);
      // Unless it was joined into the run before it already.
      if (run.prev!.next === run) this.#join(run);
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

  /**
   * `[text, states?]`, or `0` when there is no text, and its columns in
   * `out`:
   *
   * - `text`: the letters of every list, in order.
   * - Per list: whether its node is not the one after the previous list's
   *   (the first: `root`), then its id, and whether another list follows;
   *   its number of runs, but for the last list, which has the letters
   *   left.
   * - Per run (runs that only differ by being apart are one): its shape
   *   (length and flags), and only the fields the run before does not imply:
   *   its session, its counter. The last run's length, when long, is the
   *   letters left. Per list with state, the runs of each state, as
   *   `count, state` (an index in `states`, plus one).
   * - The ghosts (see `Ghosts`), by their anchor, in the order of the lists
   *   (a list's start, then each letter, is one place): see `GhostWriter`.
   */
  toStored(
    sessions: SessionTable,
    out: { encode(): string }[],
    root: string,
  ): StoredLetters | 0 {
    const ghosts = this.#ghosts;
    const flows = this.#sortedFlows().filter(
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
    // Without ghosts, none of its code runs: a cold save compiles less.
    const ghostWriter = ghosts.empty
      ? undefined
      : new GhostWriter(sessions, ghosts, stateIndex);
    const flowFlags = new ColumnWriter(flows.length);
    const flowRuns = new ColumnWriter(flows.length);
    const shapeColumn = new ColumnWriter(1024);
    const nodeSessions = new ColumnWriter(flows.length);
    const nodeClocks = new ColumnWriter(flows.length);
    const stateRuns = new ColumnWriter();
    const fields = new FieldWriter();
    /** The shapes (their flags), in the order runs first have them. */
    const shapeBits: number[] = [];
    /** How many runs have each shape, by its flags. */
    const uses = new Int32Array(BITS_ALL);
    const ends: number[] = [];
    const texts: string[] = [];
    let curSession = 0;
    let expectedKey: string | undefined = root;
    // Where the last run's long length is in `fields`, and where it ends.
    let longAt = 0;
    let longEnd = -1;
    for (const flow of flows) {
      let flags = flow === flows.at(-1) ? 0 : FLOW_MORE;
      if (expectedKey !== flow.node) {
        flags |= FLOW_KEY;
        nodeSessions.push(sessions.node(flow.node));
        nodeClocks.push(sessions.clock);
      }
      expectedKey = nextId(flow.node);
      ghostWriter?.place(flow.node, -1, -1, 1);
      let hasState = false;
      for (let run = flow.head.next; run; run = run.next)
        if (run.state) hasState = true;
      if (hasState) flags |= FLOW_STATES;
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
        if (ghostWriter)
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
        if (length >= LONG) {
          longAt = fields.length;
          fields.write(length - LONG, CUT_LONG);
          longEnd = fields.length;
        } else longEnd = -1;
        if (session === backS && run.c === backEnd) bits |= BITS_RESUME;
        else if (session === prevS && run.c + length === prevC)
          bits |= BITS_BEFORE;
        else {
          if (session !== curSession) {
            bits |= BITS_SESSION;
            fields.writeSigned(session - curSession, CUT_SESSION);
          }
          const expected = ends[session] ?? 0;
          if (run.c !== expected) {
            bits |= BITS_COUNTER;
            fields.writeSigned(run.c - expected, CUT_COUNTER);
          }
        }
        curSession = session;
        ends[session] = run.c + length;
        backS = prevS;
        backEnd = prevEnd;
        prevS = session;
        prevC = run.c;
        prevEnd = run.c + length;
        if (!uses[bits]!++) shapeBits.push(bits);
        // A long length is `0`, with the rest in `fields`. By its flags
        // here, by its shape's rank once all are counted.
        shapeColumn.push(bits * LONG + (length < LONG ? length : 0));
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
      // The last list has the letters left.
      if (flags & FLOW_MORE) flowRuns.push(runs);
    }
    // The last run's long length, last in `fields`, is the letters left.
    if (longEnd === fields.length) fields.cut(longAt);
    // The shapes most runs have first (a stable sort: else the first
    // used), with lower codes.
    shapeBits.sort((a, b) => uses[b]! - uses[a]!);
    const shapes = new ColumnWriter();
    for (const bits of shapeBits) shapes.push(bits);
    shapeColumn.remap(
      new Int32Array(BITS_ALL * LONG).map(
        (_, code) => shapeBits.indexOf(code >> 4) * LONG + (code % LONG),
      ),
    );
    // In the order of `COLUMN_*`: those a text of one list leaves empty last.
    out.push(
      // Without letters (only ghosts), the runs' are left out.
      ...(texts.length ? [shapeColumn, fields, shapes] : []),
      // Without ghosts, their columns are empty.
      ...(ghostWriter?.columns ??
        Array<ColumnWriter>(5).fill(new ColumnWriter())),
      flowFlags,
      flowRuns,
      stateRuns,
      nodeSessions,
      nodeClocks,
    );
    // No letters: `1`, and the runs' columns are left out.
    const stored: StoredLetters = [texts.join("") || 1];
    if (states.length > 0) stored.push(states);
    return stored;
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
    const flow = this.#flow(node);
    const left = this.#boundary(flow, index)[1];
    const right = this.#after(left);
    const rules = this.#rules(flow);
    const own = attrs && this.#ownFor(rules, text, left, right, attrs);
    const id = this.#mint(doc, text.length);
    const s = id[0];
    const c = id[1];
    const payload: EditOperation = [3, s, c, contentOf(text, own)];
    if (left.run.c === -1) payload.push(this.#startRef(doc, node));
    else this.#neighbours(doc, payload, s, c, left, right);
    const inverse = this.#insert(doc, s, c, text, own, rules, left, right);
    this.#record(doc, payload, inverse);
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
  #applyState(
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
        const [first, last] = this.#ends([range]);
        if (first && last)
          this.#setBetween(first, last, key, value, old, touched);
      }
    }
    return this.#stateDone(doc, s, c, key, old, touched);
  }

  /** `[3, 1, s, c, ranges]`: the letters leave their list. */
  #applyDelete(
    doc: Doc,
    s: string,
    c: number,
    ranges: [string, number, number][],
  ): EditOperation | undefined {
    const removed: Run[] = [];
    for (const [rs, rc, len] of ranges)
      for (let k = 0; k < len; ) {
        const found = this.#find(rs, rc + k);
        if (!found) {
          k++;
          continue;
        }
        const take = Math.min(found.run.len - found.off, len - k);
        const run = this.#startingAt(found);
        if (take < run.len) this.#split(run, take);
        removed.push(run);
        k += take;
      }
    if (removed.length === 0) return undefined;
    // Its undo goes back between the letters around it. Ranges are in the
    // order of the list, which never changes: those before the first one and
    // after the last one stay.
    const left = removed[0]!.prev!;
    const right = removed.at(-1)!.next;
    const rules = this.#rules(left.flow);
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
      // Its ghost: after the letter before it, which stays (a list's start
      // is its node's id at -1, and nothing reads whether it anchors).
      const before = run.prev!;
      this.#ghosts.add(
        run.s,
        run.c,
        run.len,
        before.s,
        before.c === -1 ? -1 : before.c + before.len - 1,
        run.anchors,
        this.#inheritable(run.state, rules),
      );
      before.anchors = true;
      this.#unlink(run);
    }
    this.#report(doc, left.flow.node);
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
        ? this.#startRef(doc, left.flow.node)
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
   * `[3, 6, s, c, key, ranges, value, right?]`: `setLetterState` of a key
   * letters inherit from the letter before them (`"origin"`, see
   * `Inherit`). Its ranges were together: all that is between the first
   * and the last letter still here takes the value, as in `#applyState`.
   * So do the letters typed since right after them and before `right`, the
   * letter that was after them, if they have the value the last one had
   * (they would have inherited it), up to an opaque one. `right` left out
   * is the id after the last range; `0`, the end of the text.
   */
  #applyFormat(
    doc: Doc,
    payload: EditOperation,
    s: string,
    c: number,
  ): EditOperation | undefined {
    const key = stringOf(payload[4]);
    const value = payload[6] ?? null;
    const ranges = decodeRanges(s, payload[5]!);
    const [first, last] = this.#ends(ranges);
    if (!first || !last) return undefined;
    const was = last.run.state?.[key] ?? null;
    const ls = last.run.s;
    const lc = last.run.c + last.off;
    const old: OldValues = new Map();
    const touched: Run[] = [];
    this.#setBetween(first, last, key, value, old, touched);
    const right = payload[7];
    const [rs, rc, len] = ranges.at(-1)!;
    const [ss, sc] =
      right === undefined
        ? [rs, rc + len]
        : right === 0
          ? ["", -1]
          : decodeRef(s, right);
    const rules = this.#rules(last.run.flow);
    if (rules && (sc === -1 || this.#find(ss, sc)))
      for (let at = this.#after(this.#find(ls, lc)!); at; ) {
        const { run, off } = at;
        const length = run.len;
        const stop =
          run.s === ss && sc >= run.c + off && sc < run.c + length
            ? sc - run.c
            : length;
        const end = off + cutIn(run.text.slice(off, stop), rules.opaque);
        const following = run.next;
        if (end > off && sameValue(run.state?.[key] ?? null, was))
          this.#setState(run, off, end, key, value, old, touched);
        if (end < length) break;
        at = following && { run: following, off: 0 };
      }
    return this.#stateDone(doc, s, c, key, old, touched);
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
  #applyRestore(
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
          ? this.#find(ls, lc + len)
          : this.#find(...decodeRef(s, right));
    const [as, ac] = isStart(left)
      ? ["", -1]
      : left === -1
        ? [fs, fc - 1]
        : decodeRef(s, left);
    let at = next
      ? this.#before(next)
      : isStart(left)
        ? this.#start(doc, left)
        : this.#find(as, ac);
    // Both deleted: where the left one was.
    at ??= this.#anchorOf(as, ac);
    if (!at) return undefined;
    const states = listOf(payload[6]) ?? [text.length, 0];
    const back: [string, number, number][] = [];
    let from = 0;
    let piece = 0;
    let pieceLeft = 0;
    let state: State | undefined;
    for (const [rs, rc, length] of ranges) {
      this.#checkSession(doc, rs, rc + length);
      for (let k = 0; k < length; k++, from++, pieceLeft--) {
        if (pieceLeft === 0) {
          pieceLeft = Number(states[piece]);
          const written = states[piece + 1];
          state = isState(written) ? this.#intern(written) : undefined;
          piece += 2;
        }
        const found = this.#find(rs, rc + k);
        if (found) {
          at = found;
          continue;
        }
        at = this.#place(at, rs, rc + k, text[from]!, state);
        pushRange(back, rs, rc + k, 1);
      }
    }
    if (back.length === 0) return undefined;
    for (const [rs, rc, length] of back) this.#ghosts.drop(rs, rc, length);
    // Back with their ids, they may go on the run after them again.
    this.#join(at.run);
    this.#report(doc, at.run.flow.node);
    return [3, TAG_DELETE, s, c, encodeRanges(s, back)];
  }

  static fromStored(
    stored: Json[],
    columns: string[],
    sessions: string[],
    root: string,
  ): BaseText {
    const store = new BaseText();
    const [text, states] = stored;
    const letters = stringOf(text);
    // Without letters, the runs' columns were left out.
    const all = text === 1 ? ["", "", "", ...columns] : columns;
    const table = (listOf(states) ?? [])
      .filter(isState)
      .map((state) => store.#intern(state));
    const column = (field: number) => new ColumnReader(all[field] ?? "");
    const flowFlags = column(COLUMN_FLOW_FLAGS);
    const flowRuns = column(COLUMN_FLOW_RUNS);
    const shapeColumn = column(COLUMN_SHAPE);
    const shapes = column(COLUMN_SHAPES);
    const fields = new FieldReader(all[COLUMN_FIELDS] ?? "");
    const nodeSessions = column(COLUMN_NODE_SESSION);
    const nodeClocks = column(COLUMN_NODE_CLOCK);
    const stateRuns = column(COLUMN_STATE_RUNS);
    const ghosts = new GhostReader(
      all.slice(COLUMN_GHOST_PLACES, COLUMN_FLOW_FLAGS),
      sessions,
      table,
      store.#ghosts,
    );
    const shapeBits: number[] = [];
    while (!shapes.done) shapeBits.push(shapes.next());
    const bySession = new Map<string, Run[]>();
    const ends: number[] = [];
    let curSession = 0;
    let position = 0;
    let expected: string | undefined = root;
    for (let flags = FLOW_MORE; flags & FLOW_MORE; ) {
      flags = flowFlags.next();
      const key =
        flags & FLOW_KEY
          ? joinId(sessions[nodeSessions.next()]!, nodeClocks.next())
          : expected!;
      expected = nextId(key);
      // The last list has the letters left.
      const last = !(flags & FLOW_MORE);
      const flow = store.#flow(key);
      ghosts.read(key, -1, -1, 1);
      let prev = flow.head;
      let stateLeft = 0;
      let state: State | undefined;
      let prevS = -1;
      let prevC = 0;
      let prevEnd = 0;
      let backS = -1;
      let backEnd = 0;
      for (
        let left = last ? Infinity : flowRuns.next();
        last ? position < letters.length : left > 0;
        left--
      ) {
        const code = shapeColumn.next();
        const bits = shapeBits[Math.floor(code / LONG)] ?? 0;
        let length = code % LONG;
        // A long one; past the end of `fields`, the letters left.
        if (length === 0)
          length = fields.done
            ? letters.length - position
            : LONG + fields.read(CUT_LONG);
        let session: number;
        let c: number;
        if (bits & BITS_RESUME) {
          session = backS;
          c = backEnd;
        } else if (bits & BITS_BEFORE) {
          session = prevS;
          c = prevC - length;
        } else {
          session =
            curSession +
            (bits & BITS_SESSION ? fields.readSigned(CUT_SESSION) : 0);
          c = ends[session] ?? 0;
          if (bits & BITS_COUNTER) c += fields.readSigned(CUT_COUNTER);
        }
        curSession = session;
        ends[session] = c + length;
        backS = prevS;
        backEnd = prevEnd;
        prevS = session;
        prevC = c;
        prevEnd = c + length;
        if (flags & FLOW_STATES) {
          if (stateLeft === 0) {
            stateLeft = stateRuns.next();
            state = table[stateRuns.next() - 1];
          }
          stateLeft--;
        }
        const s = sessions[session]!;
        const run = new Run(
          s,
          c,
          letters.slice(position, position + length),
          state,
          flow,
        );
        run.anchors = ghosts.read(s, session, c, length);
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
      store.#index.set(session, SessionRuns.from(runs));
    store.#ghosts.finish(ghosts.loaded);
    return store;
  }

  // ----- test inspection ---------------------------------------------------

  protected _debugRuns(): string[][] {
    return this.#sortedFlows().map((flow) => {
      const runs: string[] = [];
      for (let run = flow.head.next; run; run = run.next) runs.push(run.text);
      return runs;
    });
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
      "",
    );
  }

  /** How many columns `toStored` wrote: the runs' three, only with letters. */
  static columns(stored: Json[]): number {
    return stored[0] === 1 ? 10 : 13;
  }

  /**
   * Base reads the rules of a node from its type, when the letters are
   * inserted (see `#rules`): every replica reads the same.
   */
  setRules(): void {
    // Nothing to keep.
  }
}

/** Whether a reference is a node's start: `^node` or `#hash` (see `#startRef`). */
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
 * What of each state a ghost keeps, by rules (see `#inheritable`); `false`:
 * nothing. A state belongs to one text, so the result is that text's.
 */
const keptByRules = new WeakMap<Rules, WeakMap<State, State | false>>();

/** A letter's state as written: an object of JSON values. */
const isState = (value: Json | undefined): value is State => isRecord(value);

function encodeRanges(own: string, ranges: [string, number, number][]): Json {
  if (ranges.length === 1) {
    const [s, c, len] = ranges[0]!;
    return encodeRange(own, s, c, len);
  }
  const out: Json[] = [];
  for (const [s, c, len] of ranges) out.push(encodeRef(own, s, c), len);
  return out;
}

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

/** Flags of a stored list. */
/** Its node id is not the one right after the previous list's. */
const FLOW_KEY = 1;
/** Its runs have state (see `COLUMN_STATE_RUNS`). */
const FLOW_STATES = 2;
/** Another list follows it. */
const FLOW_MORE = 4;
/** Flags of a stored run. */
/** Its session is not the one of the run before (by how far its index is). */
const BITS_SESSION = 1;
/** Its counter is not where its session's last run ended. */
const BITS_COUNTER = 2;
/** It ends where the run before starts, of its session: typed before it. */
const BITS_BEFORE = 4;
/**
 * It starts where the run before the one before ends, of its session: it
 * goes on after letters typed in the middle of it.
 */
const BITS_RESUME = 8;
const BITS_ALL = 16;
/** The columns of a stored text. */
const COLUMN_SHAPE = 0;
/** The fields of the runs one after the other (see `CUT_*`). */
const COLUMN_FIELDS = 1;
const COLUMN_SHAPES = 2;
/** The ghosts' columns (see `GhostWriter`): five. */
const COLUMN_GHOST_PLACES = 3;
const COLUMN_FLOW_FLAGS = 8;
const COLUMN_FLOW_RUNS = 9;
/** Per list with state: `count, state` for each stretch of runs. */
const COLUMN_STATE_RUNS = 10;
const COLUMN_NODE_SESSION = 11;
const COLUMN_NODE_CLOCK = 12;
const CUT_LONG = 48;
const CUT_SESSION = 8;
const CUT_COUNTER = 40;
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
  readonly #places = new ColumnWriter(64, false, true);
  readonly #sessions = new ColumnWriter();
  readonly #counters = new ColumnWriter();
  readonly #lengths = new ColumnWriter();
  readonly #states = new ColumnWriter();
  readonly #ends: number[] = [];
  /** The sorted counters of the anchors of each session (see `Ghosts.anchorsOf`). */
  readonly #anchors = new Map<string, number[]>();
  /** The place of the next letter or start, and the last anchor's. */
  #place = 0;
  #anchor = -1;
  #session = 0;

  readonly #table: SessionTable;
  readonly #ghosts: Ghosts;
  readonly #stateIndex: (state: State | undefined) => number;

  constructor(
    table: SessionTable,
    ghosts: Ghosts,
    stateIndex: (state: State | undefined) => number,
  ) {
    this.#table = table;
    this.#ghosts = ghosts;
    this.#stateIndex = stateIndex;
  }

  /** In the order that stores them smallest, measured on every document. */
  get columns(): ColumnWriter[] {
    return [
      this.#counters,
      this.#places,
      this.#states,
      this.#lengths,
      this.#sessions,
    ];
  }

  /**
   * The ghosts anchored at the next `length` places: letters of `as` (index
   * `session`) from counter `c`, or the start of list `as` (`-1`, `-1`).
   */
  place(as: string, session: number, c: number, length: number): void {
    let anchors = this.#anchors.get(as);
    if (!anchors) this.#anchors.set(as, (anchors = this.#ghosts.anchorsOf(as)));
    for (let at = lowerBound(anchors, c); at < anchors.length; at++) {
      const ac = anchors[at]!;
      if (ac >= c + length) break;
      this.#group(this.#ghosts.at(as, ac), session, this.#place + ac - c, ac);
    }
    this.#place += length;
  }

  #group(ghosts: Ghost[], session: number, place: number, ac: number) {
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
      this.#places.push(place - this.#anchor);
      this.#anchor = place;
      const index = this.#table.index(ghost.s);
      this.#sessions.pushSigned(index - this.#session);
      this.#session = index;
      const expected =
        index === last
          ? lastEnd
          : index === session
            ? ac + 1
            : (this.#ends[index] ?? 0);
      this.#counters.pushSigned(ghost.c - expected);
      this.#lengths.push(len - 1);
      this.#states.push(this.#stateIndex(ghost.state));
      last = index;
      lastEnd = this.#ends[index] = ghost.c + len;
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
  readonly #places: ColumnReader;
  readonly #sessions: ColumnReader;
  readonly #counters: ColumnReader;
  readonly #lengths: ColumnReader;
  readonly #states: ColumnReader;
  readonly #ends: number[] = [];
  /** The ghosts read so far, by session (see `Ghosts.finish`). */
  readonly loaded = new Map<string, Ghost[]>();
  readonly #table: string[];
  readonly #stateTable: (State | undefined)[];
  readonly #ghosts: Ghosts;
  /** The place of the next letter or start, and the next anchor's. */
  #place = 0;
  #anchor: number;
  #session = 0;

  constructor(
    columns: string[],
    table: string[],
    stateTable: (State | undefined)[],
    ghosts: Ghosts,
  ) {
    this.#table = table;
    this.#stateTable = stateTable;
    this.#ghosts = ghosts;
    const column = (field: number) => new ColumnReader(columns[field] ?? "");
    this.#counters = column(0);
    this.#places = column(1);
    this.#states = column(2);
    this.#lengths = column(3);
    this.#sessions = column(4);
    this.#anchor = this.#places.done ? Infinity : this.#places.next() - 1;
  }

  /**
   * The ghosts anchored at the next `length` letters, of `s` (index
   * `session`) from counter `c`, or at the start of list `s` (`-1`, `-1`).
   * Whether there are some.
   */
  read(s: string, session: number, c: number, length: number): boolean {
    const end = this.#place + length;
    const anchors = this.#anchor < end;
    while (this.#anchor < end) {
      const ac = c === -1 ? -1 : c + this.#anchor - this.#place;
      let last = -1;
      let lastEnd = 0;
      for (let same = true; same; ) {
        const index = this.#session + this.#sessions.nextSigned();
        this.#session = index;
        const expected =
          index === last
            ? lastEnd
            : index === session
              ? ac + 1
              : (this.#ends[index] ?? 0);
        const ghostC = expected + this.#counters.nextSigned();
        const len = this.#lengths.next() + 1;
        last = index;
        lastEnd = this.#ends[index] = ghostC + len;
        const state = this.#states.next();
        this.#ghosts.load(
          {
            s: this.#table[index]!,
            c: ghostC,
            len,
            as: s,
            ac,
            state: state === 0 ? undefined : this.#stateTable[state - 1],
          },
          this.loaded,
        );
        if (this.#places.done) {
          this.#anchor = Infinity;
          break;
        }
        const step = this.#places.next();
        same = step === 0;
        this.#anchor += step;
      }
    }
    this.#place = end;
    return anchors;
  }
}
