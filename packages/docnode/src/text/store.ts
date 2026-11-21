import type { Doc } from "../main.js";
import type { Json } from "../types.js";
import { lastDot } from "../idGenerator.js";
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
import { compareStamps, kidIndex } from "../utils.js";
import {
  cutIn,
  decodeRef,
  encodeRange,
  encodeRef,
  isHighSurrogate,
  isLowSurrogate,
  lettersOf,
  listOf,
  nextId,
  pushRange,
  rulesOfNode,
  sameValue,
  SessionRuns,
  stateOfContent,
  TextEngine,
  contentOf,
  type Rules,
  type TextSpan,
} from "./common.js";
import {
  TreePositions,
  type Leaf,
  type Positions,
  type Seek,
} from "./positions.js";

/**
 * The text of the CRDT mode (`DocConfig.crdt`): one FugueMax list per node,
 * and two operations that mirror those of the tree. Base has its own, which
 * relies on the server's order (`text/baseText.ts`).
 *
 * - `insertLetters`: letters get a permanent id `(session, counter)` and a
 *   place in their node's list. Runs of consecutive ids are stored together.
 * - `setLetterState`: a key's value on a range of letters, the last writer
 *   winning per letter and key (by lamport, then session). Deleting is a key
 *   too (`DELETED`): a tombstone keeps its state, and an undo of a delete
 *   brings the same letters back.
 *
 * A key may be inherited (see `InheritRules`): a letter without a value of
 * its own for it reads the one of its left origin, the letter it was typed
 * after. Tombstones keep their state, so every replica reads the same.
 *
 * A node's text never leaves its list: nothing splits, joins or moves it.
 */

/**
 * The key that deletes letters: `true` deletes them, `false` brings them
 * back. A letter without it is visible, and a tombstone without it was
 * deleted at lamport 0. Of two writes at the same lamport, deleting wins.
 * Its lamport is its own: only bringing letters back moves it, so a text
 * nobody undid a delete of deletes at 0, which the wire leaves out.
 */
export const DELETED = "~d";

const deletedKey = () =>
  new Error(`"${DELETED}" is the key of delete: use delete()`);

/** A key's value on a letter, with the stamp of the write that set it. */
type Stamped = readonly [value: Json, lamport: number, session: string];
/** The state of a letter. Never changed in place: runs share it. */
type LetterState = Readonly<Record<string, Stamped>>;
/** The visible attributes of a letter, and them as one string. */
type Attrs = { readonly attrs: Readonly<Record<string, Json>>; key: string };

/**
 * The kids on one side of each element: by session, then at the element's
 * counter + 1 (a node's root is -1), in blocks of `KID_BLOCK` counters. Not
 * one array by counter: parents far apart (inserts at random places) would
 * make it sparse, which V8 stores as a slow dictionary.
 */
type Kids = Map<string, KidBlocks>;
type KidBlocks = ((Run[] | undefined)[] | undefined)[];
const KID_SHIFT = 8;
const KID_BLOCK = 1 << KID_SHIFT;

/** The kids at counter `c` + 1 of a session's blocks. */
const kidsAt = (blocks: KidBlocks, c: number): Run[] | undefined =>
  blocks[(c + 1) >> KID_SHIFT]?.[(c + 1) & (KID_BLOCK - 1)];

/** Sets the kids at counter `c` + 1 of a session's blocks. */
function setKidsAt(blocks: KidBlocks, c: number, list: Run[]): void {
  const at = (c + 1) >> KID_SHIFT;
  const block = (blocks[at] ??= new Array<Run[] | undefined>(KID_BLOCK));
  block[(c + 1) & (KID_BLOCK - 1)] = list;
}
const newKids = (): Kids => new Map();

/** A run of elements with consecutive ids chained as right children. */
export class Run {
  deleted = false;
  prev: Run | undefined;
  next: Run | undefined;
  flow!: Flow;
  seq = 0;
  /** The same for every letter of the run. */
  state: LetterState | undefined;
  /** What reading its attributes found out, once read (see `Derived`). */
  d: Derived | undefined;
  /** Bookkeeping of the position index (see `positions.ts`). */
  leaf: Leaf<Run> | undefined;
  vis = 0;

  constructor(
    readonly s: string,
    readonly c: number,
    public text: string,
    public ps: string | undefined,
    public pc: number,
    public side: 0 | 1,
    public rs: string | undefined,
    public rc: number,
  ) {}

  get len(): number {
    return this.text.length;
  }

  get visible(): boolean {
    return this.c !== -1 && !this.deleted;
  }
}

/**
 * What reading the attributes of a run finds out, kept apart from the run:
 * most runs are never read so (a text without rules, or only its letters).
 */
class Derived {
  /**
   * Its attributes with the inherited ones, as of `effAt` (see
   * `TextStore._epoch`). The same for every letter of the run too.
   */
  eff: Attrs | undefined;
  /** -1 before it is computed, `COMPUTING` while `_effOf` computes it. */
  effAt = -1;
  /**
   * Where its first opaque letter is (see `Rules.opaque`): from it on, its
   * letters have their own state only. Computed for `cutFor`, its text then.
   */
  cut = 0;
  cutFor: string | undefined;
  /**
   * The runs that had its left and right origin, and the left one's
   * counter, when last looked up (`NO_RUN`: the root, or none). Runs are
   * only cut or joined: a run that still has the counter still has the
   * letter (a run joined into another has no letters left).
   */
  lo: Run | undefined;
  loC = 0;
  ro: Run | undefined;
  /** Its attributes before a write `_pinsFor` tries, and that try. */
  saved: Attrs | undefined;
  savedAt = -1;
}

const derived = (run: Run) => (run.d ??= new Derived());

/** `Derived.effAt` of a run `TextStore._effOf` has yet to finish. */
const COMPUTING = -2;

/** Stands for the root, or no run (see `Derived.lo`). */
const NO_RUN = new Run("", -1, "", undefined, 0, 1, undefined, 0);

const holds = (run: Run, c: number) =>
  c >= run.c && c < run.c + run.text.length;

/** The list of one node: its root, then its letters in order. */
export class Flow {
  head: Run;
  tail: Run;
  dirty = true;
  /** The id right after the id of its node, once a save needed it. */
  nextKey: string | undefined;
  /** Its node's inherit rules, once found (see `known`). */
  rules: Rules | undefined;
  /** Whether `rules` was found: its node was in the document then. */
  known = false;

  constructor(head: Run, tail: Run) {
    this.head = head;
    this.tail = tail;
  }
}

/**
 * A letter in an operation of session `own`: `counter + 1` of `own`, else
 * `session.counter` or `^node` (see `encodeRef`).
 */
type Ref = number | string;

/**
 * Letters typed: `[3, session, counter, content, right?, parent?]`. A
 * negative `right` also makes them its left child; `parent` 0 says so too.
 */
type InsertEdit = [
  operation: 3,
  s: string,
  c: number,
  content: Json,
  ...refs: [] | [right: Ref] | [right: Ref, parent: Ref],
];
/** `setLetterState` of `DELETED` (see `_applyDelete`). */
type DeleteEdit = [
  operation: 3,
  tag: typeof TAG_DELETE,
  s: string,
  c: number,
  ranges: Json,
  ...rest: [] | [lamport: number] | [lamport: number, letters: string],
];
/** `setLetterState` of another key (see `_applyState`). */
type StateEdit = [
  operation: 3,
  tag: typeof TAG_STATE,
  s: string,
  c: number,
  lamport: number,
  key: string,
  ...groups: Json[],
];
/** What an undo of the history applies: the inverse of an edit. */
export type TextInverse = DeleteEdit | StateEdit;
/**
 * The `EditOperation`s of a text. The core hands each edit back to the kind
 * that wrote it, as `applyEdit` and `prepareUndo` (see `defineText`).
 */
export type TextEdit = InsertEdit | TextInverse;

/** The columns of a stored text after its letters (see `toStored`). */
type StoredColumns =
  | []
  | [keys: string[]]
  | [keys: string[], values: Json[]]
  | [keys: string[], values: Json[], states: number[][]]
  | [keys: string[], values: Json[], states: number[][], pending: string[]];
/** `[text, keys?, values?, states?, pending?]` (see `toStored`). */
export type StoredText = [text: string, ...columns: StoredColumns];
/** `[11, sessions, text, columns, ...rest]` (see `toJSON`). */
export type TextJson = [
  format: number,
  table: string[],
  text: string,
  columns: string,
  ...rest: StoredColumns,
];

/** An edit without its kind, as a stored document keeps it. */
type StoredEdit = TextEdit extends [3, ...infer Payload] ? Payload : never;

type EditResult = TextInverse | undefined;
const PENDING = Symbol("pending");

const id = (s: string, c: number) => `${s}:${c}`;

function compareIds(as: string, ac: number, bs: string, bc: number): number {
  if (as !== bs) return as < bs ? -1 : 1;
  return ac - bc;
}

/** An element, possibly in the middle of a run. */
type Element = { run: Run; off: number };

function sameState(
  a: LetterState | undefined,
  b: LetterState | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  let count = 0;
  for (const key in a) {
    const x = a[key]!;
    const y = b[key];
    if (x[1] !== y?.[1] || x[2] !== y[2] || !sameValue(x[0], y[0]))
      return false;
    count++;
  }
  for (const _ in b) count--;
  return count === 0;
}

/** Whether a write stamped `(lamport, session)` beats `current`. */
const wins = (lamport: number, session: string, current: Stamped) =>
  compareStamps(lamport, session, current[1], current[2]) > 0;

/** A state as one string, cached per state object (see `toStored`). */
const canonCache = new WeakMap<LetterState, string>();
function canonOf(state: LetterState): string {
  let canon = canonCache.get(state);
  if (canon === undefined) {
    const entries: [string, Stamped][] = [];
    for (const key of Object.keys(state).sort())
      entries.push([key, state[key]!]);
    canonCache.set(state, (canon = JSON.stringify(entries)));
  }
  return canon;
}

/** The visible attributes of a state, cached per state object. */
const attrsCache = new WeakMap<LetterState, Attrs>();
const NO_ATTRS: Attrs = { attrs: {}, key: "{}" };
function attrsOf(state: LetterState | undefined): Attrs {
  if (!state) return NO_ATTRS;
  let cached = attrsCache.get(state);
  if (cached) return cached;
  const attrs: Record<string, Json> = {};
  for (const key of Object.keys(state).sort()) {
    const value = state[key]![0];
    if (value !== null && key !== DELETED) attrs[key] = value;
  }
  cached = { attrs, key: JSON.stringify(attrs) };
  attrsCache.set(state, cached);
  return cached;
}

/**
 * The attributes of a letter with `own` state whose left origin has `left`
 * and right origin `right` (see `Inherit`).
 */
function withInherited(
  rules: Rules,
  own: LetterState | undefined,
  left: Attrs | undefined,
  right: Attrs | undefined,
): Attrs {
  const base = attrsOf(own);
  if (!left) return base;
  let extra: Record<string, Json> | undefined;
  for (const key in left.attrs) {
    const rule = rules.get(key);
    if (rule === undefined || (own && Object.hasOwn(own, key))) continue;
    const value = left.attrs[key]!;
    if (rule === "both") {
      const other =
        right && Object.hasOwn(right.attrs, key) ? right.attrs[key] : undefined;
      if (other === undefined || !sameValue(value, other)) continue;
    }
    (extra ??= {})[key] = value;
  }
  if (!extra) return base;
  const merged: Record<string, Json> = { ...base.attrs, ...extra };
  const attrs: Record<string, Json> = {};
  for (const key of Object.keys(merged).sort()) attrs[key] = merged[key]!;
  return { attrs, key: JSON.stringify(attrs) };
}

/** The first state of inserted letters (see `stateOfContent`), at lamport 0. */
function initialState(content: Json | undefined): LetterState | undefined {
  const plain = stateOfContent(content);
  if (!plain) return undefined;
  const state: Record<string, Stamped> = {};
  for (const key in plain) state[key] = [plain[key]!, 0, ""];
  return state;
}

export class TextStore extends TextEngine {
  private _session: string | undefined;
  private _counter = 0;
  private _renewals = 0;
  private _lamport = 0;
  /** The lamport of `DELETED` alone: only bringing letters back moves it. */
  private _deletes = 0;
  private _index = new Map<string, SessionRuns<Run>>();
  private _roots = new Map<string, Run>();
  private _flows: Flow[] = [];
  private _sorted: Flow[] | undefined;
  private _kids: [Kids, Kids] = [newKids(), newKids()];
  private _kidsReady = true;
  private _pending: TextEdit[] = [];
  /** Runs that may now join the run after them (see `_settle`). */
  private _cut: Run[] = [];
  /**
   * Bumped by every change of state that letters may inherit: the
   * attributes runs computed before it (`Run.eff`) are computed again.
   */
  private _epoch = 0;
  /** Counts the writes `_pinsFor` tries. */
  private _tries = 0;
  /** Finds the inherit rules of a node (see `bind`). */
  /** The document whose nodes say their rules (see `bind`). */
  private _doc: Doc | undefined;
  /** Rules `setRules` gave, for nodes that may have no text yet. */
  private _given: Map<string, Rules | undefined> | undefined;
  protected _positions: Positions<Run> = new TreePositions<Run>();

  /**
   * The document whose nodes say the inherit rules of their text: those of
   * the `defineText` state of their type.
   */
  bind(doc: Doc): void {
    this._doc = doc;
  }

  /** The inherit rules of a node, known before it is in the document. */
  setRules(node: string, rules: Rules | undefined): void {
    const given = (this._given ??= new Map());
    if (given.get(node) === rules && given.has(node)) return;
    given.set(node, rules);
    const flow = this._roots.get(node)?.flow;
    if (!flow || (flow.known && flow.rules === rules)) return;
    flow.rules = rules;
    flow.known = true;
    this._epoch++;
  }

  /** The opaque letters of a flow, undefined when its rules are unknown. */
  private _opaqueOf(flow: Flow): string | undefined {
    const rules = this._rulesOf(flow);
    if (!flow.known) return undefined;
    return rules ? rules.opaque : "";
  }

  private _rulesOf(flow: Flow): Rules | undefined {
    if (flow.known) return flow.rules;
    const node = flow.head.s;
    const given = this._given;
    const rules =
      given?.has(node) === true
        ? given.get(node)
        : rulesOfNode(this._doc, node);
    if (rules === false) return undefined;
    flow.rules = rules;
    flow.known = true;
    // What was read without them is read again.
    if (rules) this._epoch++;
    return rules;
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
      // counters go on after the letters the document holds. One it already
      // has would be read as that letter (and as `CONTINUES`).
      this._counter = this._index.get(this._session)?.end() ?? 0;
    }
    const counter = this._counter;
    this._counter += length;
    return [this._session, counter];
  }

  private _find(s: string, c: number): Element | undefined {
    const run = this._runAt(s, c);
    return run && { run, off: c - run.c };
  }

  private _runAt(s: string, c: number): Run | undefined {
    return this._index.get(s)?.find(c);
  }

  /** Finds the element, creating a node's root if needed. */
  private _locate(s: string, c: number): Element | undefined {
    if (c === -1) return { run: this._rootOf(s), off: 0 };
    return this._find(s, c);
  }

  private _kidsOf(side: 0 | 1, s: string, c: number): Run[] | undefined {
    this._ensureKids();
    const blocks = this._kids[side].get(s);
    return blocks && kidsAt(blocks, c);
  }

  private _kidsIn(side: 0 | 1, s: string): KidBlocks {
    const kids = this._kids[side];
    let bySession = kids.get(s);
    if (!bySession) kids.set(s, (bySession = []));
    return bySession;
  }

  private _indexRun(run: Run): void {
    let runs = this._index.get(run.s);
    if (!runs) this._index.set(run.s, (runs = new SessionRuns<Run>()));
    runs.add(run);
  }

  private _rootOf(node: string): Run {
    const existing = this._roots.get(node);
    if (existing) return existing;
    const run = new Run(node, -1, "", undefined, 0, 1, undefined, 0);
    const flow = new Flow(run, run);
    run.flow = flow;
    this._flows.push(flow);
    this._sorted = undefined;
    this._roots.set(node, run);
    // While its node is there: a save needs them after it is gone too.
    this._rulesOf(flow);
    return run;
  }

  // ----- list order --------------------------------------------------------

  private _ensureSeq(flow: Flow): void {
    if (!flow.dirty) return;
    let seq = 0;
    for (let run: Run | undefined = flow.head; run; run = run.next) {
      run.seq = seq;
      seq += run.len;
    }
    flow.dirty = false;
  }

  /** The position of a right origin, `Infinity` for none. */
  private _position(s: string | undefined, c: number): number {
    if (s === undefined) return Infinity;
    // A right origin is known before the letter it is the right origin of.
    const run = this._runAt(s, c)!;
    this._ensureSeq(run.flow);
    return run.seq + c - run.c;
  }

  /** FugueMax: right siblings in the reverse order of their right origins, then by id. */
  private _rightBefore(a: Run, aOff: number, b: Run, bOff: number): boolean {
    // Two right origins in one list are never at the same position.
    if (a.rs !== b.rs || a.rc !== b.rc)
      return this._position(a.rs, a.rc) > this._position(b.rs, b.rc);
    return compareIds(a.s, a.c + aOff, b.s, b.c + bOff) < 0;
  }

  private _leftBefore(a: Run, b: Run): boolean {
    return compareIds(a.s, a.c, b.s, b.c) < 0;
  }

  /** The index of the first kid that element `off` of `run` sorts before. */
  private _rightIndex(kids: Run[], run: Run, off: number): number {
    return kidIndex(kids, (kid) => this._rightBefore(run, off, kid, 0));
  }

  private _leftIndex(kids: Run[], run: Run): number {
    return kidIndex(kids, (kid) => this._leftBefore(run, kid));
  }

  private _nextSibling(
    run: Run,
    off: number,
    anchor: Run,
  ): Element | undefined {
    const kids = this._kidsOf(1, run.s, run.c + off) ?? [];
    const index = this._rightIndex(kids, anchor, 0);
    if (
      off < run.len - 1 &&
      index >= this._rightIndex(kids, run, off + 1) &&
      this._rightBefore(anchor, 0, run, off + 1)
    )
      return { run, off: off + 1 };
    return index < kids.length ? { run: kids[index]!, off: 0 } : undefined;
  }

  private _hasRightChild(run: Run, off: number): boolean {
    return (
      off < run.len - 1 ||
      (this._kidsOf(1, run.s, run.c + off)?.length ?? 0) > 0
    );
  }

  private _leftmost(element: Element): Element {
    let current = element;
    while (true) {
      const kids = this._kidsOf(0, current.run.s, current.run.c + current.off);
      if (!kids?.length) return current;
      current = { run: kids[0]!, off: 0 };
    }
  }

  private _rightmost(run: Run, off: number): Run {
    while (true) {
      const kids = this._kidsOf(1, run.s, run.c + off);
      const last = kids?.at(-1);
      if (
        off < run.len - 1 &&
        (!last || !this._rightBefore(run, off + 1, last, 0))
      )
        off++;
      else if (last) {
        run = last;
        off = 0;
      } else return run;
    }
  }

  private _startingAt(element: Element): Run {
    if (element.off === 0) return element.run;
    return this._split(element.run, element.off);
  }

  private _split(run: Run, offset: number): Run {
    const tail = new Run(
      run.s,
      run.c + offset,
      run.text.slice(offset),
      run.s,
      run.c + offset - 1,
      1,
      run.rs,
      run.rc,
    );
    run.text = run.text.slice(0, offset);
    this._positions.changed(run);
    tail.deleted = run.deleted;
    tail.state = run.state;
    // The tail has the attributes of the run, unless an opaque letter of
    // the run is before it or starts it (see `Run.cut`).
    const opaque = run.flow.rules ? run.flow.rules.opaque : "";
    if (cutIn(run.text, opaque) === offset && !opaque.includes(tail.text[0]!)) {
      const from = run.d;
      if (from?.effAt === this._epoch) {
        const to = derived(tail);
        to.eff = from.eff;
        to.effAt = from.effAt;
      }
    }
    tail.flow = run.flow;
    this._indexRun(tail);
    this._linkAfter(run, tail);
    this._addKid(tail);
    run.flow.dirty = true;
    // Both: a later cut of `run` puts a run between them, which only the
    // tail sees again (see `_settle`).
    this._cut.push(run, tail);
    return tail;
  }

  private _linkAfter(target: Run, run: Run): void {
    const flow = target.flow;
    this._positions.linked(target, run, true);
    const next = target.next;
    target.next = run;
    run.prev = target;
    run.next = next;
    if (next) next.prev = run;
    else flow.tail = run;
    flow.dirty = true;
  }

  private _linkBefore(target: Run, run: Run): void {
    const flow = target.flow;
    this._positions.linked(target, run, false);
    const prev = target.prev;
    target.prev = run;
    run.next = target;
    run.prev = prev;
    // A node's root is always first: nothing goes before it.
    prev!.next = run;
    flow.dirty = true;
  }

  private _addKid(run: Run): void {
    this._ensureKids();
    const bySession = this._kidsIn(run.side, run.ps!);
    const list = kidsAt(bySession, run.pc);
    if (!list) {
      setKidsAt(bySession, run.pc, [run]);
      return;
    }
    const index =
      run.side === 1
        ? this._rightIndex(list, run, 0)
        : this._leftIndex(list, run);
    if (index === list.length) list.push(run);
    else list.splice(index, 0, run);
  }

  private _removeKid(run: Run): void {
    const list = this._kidsOf(run.side, run.ps!, run.pc)!;
    list.splice(list.indexOf(run), 1);
  }

  /** Places a new run where its parent, side and right origin say. */
  private _place(run: Run, parent: Element): void {
    const { run: parentRun, off } = parent;
    run.flow = parentRun.flow;
    if (run.side === 1) {
      const next = this._nextSibling(parentRun, off, run);
      if (next) this._linkBefore(this._startingAt(this._leftmost(next)), run);
      else this._linkAfter(this._rightmost(parentRun, off), run);
    } else {
      const kids = this._kidsOf(0, parentRun.s, parentRun.c + off) ?? [];
      const index = this._leftIndex(kids, run);
      const target =
        index < kids.length
          ? this._leftmost({ run: kids[index]!, off: 0 })
          : parent;
      this._linkBefore(this._startingAt(target), run);
    }
    this._addKid(run);
  }

  // ----- inherited state ----------------------------------------------------

  /** The left origin of the first letter of `run`, or undefined for the root. */
  private _originOf(run: Run): Element | undefined {
    const d = derived(run);
    const known = d.lo;
    if (known === NO_RUN) return undefined;
    if (known && holds(known, d.loC))
      return { run: known, off: d.loC - known.c };
    const found = this._findOrigin(run);
    d.lo = found ? found.run : NO_RUN;
    d.loC = found ? found.run.c + found.off : 0;
    return found;
  }

  /** The right origin of `run`, if any (see `Derived.ro`). */
  private _rightOf(run: Run): Element | undefined {
    if (run.rs === undefined) return undefined;
    const d = derived(run);
    const known = d.ro;
    if (known && holds(known, run.rc))
      return { run: known, off: run.rc - known.c };
    // A right origin is known before the letter it is the right origin of.
    const found = this._locate(run.rs, run.rc)!;
    d.ro = found.run;
    return found;
  }

  private _findOrigin(run: Run): Element | undefined {
    let current = run;
    while (true) {
      // Letters always have a parent: the root, at least.
      const parent = this._locate(current.ps!, current.pc)!;
      if (parent.run.c === -1) return undefined;
      // Fugue paper, Lemma 8(a): a left child has its parent's left origin.
      if (current.side === 1) return parent;
      // A left child is right before its parent, which so starts a run.
      current = parent.run;
    }
  }

  /** Where the first opaque letter of `run` is (see `Run.cut`). */
  private _cutOf(run: Run, rules: Rules): number {
    const d = derived(run);
    if (d.cutFor !== run.text) {
      d.cut = cutIn(run.text, rules.opaque);
      d.cutFor = run.text;
    }
    return d.cut;
  }

  /**
   * The attributes of the letters of `run`, inherited ones included: of all
   * of them, or of those before its first opaque letter (see `Run.cut`).
   */
  private _effOf(run: Run): Attrs {
    const rules = this._rulesOf(run.flow);
    if (!rules) return attrsOf(run.state);
    if (run.d?.effAt === this._epoch) return run.d.eff!;
    // Origins come before what was typed next to them: no cycles, but long
    // chains, walked without recursion.
    // Only what is before an opaque letter is asked for or pushed (see
    // `_effKnown`), and a run only once: it is computed before it is asked
    // for again.
    const stack = [run];
    derived(run).effAt = COMPUTING;
    while (stack.length > 0) {
      const top = stack.at(-1)!;
      const left = this._acyclic(this._originOf(top), rules);
      if (left && !this._effKnown(left, rules)) {
        derived(left.run).effAt = COMPUTING;
        stack.push(left.run);
        continue;
      }
      const right = this._acyclic(this._rightOf(top), rules);
      if (right && !this._effKnown(right, rules)) {
        derived(right.run).effAt = COMPUTING;
        stack.push(right.run);
        continue;
      }
      const d = derived(top);
      d.eff = withInherited(
        rules,
        top.state,
        this._effAt(left),
        this._effAt(right),
      );
      // The epoch after reading the origins: one in a flow whose rules were
      // not known yet moves it, and with the epoch from before, this run
      // would never count as known and be computed forever.
      d.effAt = this._epoch;
      stack.pop();
    }
    return run.d!.eff!;
  }

  /**
   * `element`, unless its attributes need a run that waits for the ones
   * being computed: origins in a cycle, which only letters of two replicas
   * with the same session make (see `NodeIds`). It is read as no origin, or
   * the stack would grow until memory runs out.
   */
  private _acyclic(
    element: Element | undefined,
    rules: Rules,
  ): Element | undefined {
    return element?.run.d?.effAt === COMPUTING &&
      !this._effKnown(element, rules)
      ? undefined
      : element;
  }

  /** Whether the attributes of `element` need no computing. */
  private _effKnown(element: Element, rules: Rules): boolean {
    const run = element.run;
    return (
      run.c === -1 ||
      run.d?.effAt === this._epoch ||
      element.off >= this._cutOf(run, rules)
    );
  }

  /** The attributes of an element; the root has none. */
  private _effAt(element: Element | undefined): Attrs | undefined {
    if (!element || element.run.c === -1) return undefined;
    const run = element.run;
    const rules = this._rulesOf(run.flow);
    if (rules && element.off >= this._cutOf(run, rules))
      return attrsOf(run.state);
    return this._effOf(run);
  }

  /**
   * The parts of `run` with the same attributes: `[length, attrs]` of the
   * letters before its first opaque one, then of the rest.
   */
  private _effParts(run: Run): [number, Attrs][] {
    const rules = this._rulesOf(run.flow);
    const cut = rules ? this._cutOf(run, rules) : run.len;
    if (cut >= run.len) return [[run.len, this._effOf(run)]];
    const rest: [number, Attrs] = [run.len - cut, attrsOf(run.state)];
    return cut === 0 ? [rest] : [[cut, this._effOf(run)], rest];
  }

  /**
   * The first state of letters typed with `parent`, `side` and `next`: what
   * they must say of their own to have `attrs`. Without `attrs`, they say
   * nothing: they have what they inherit.
   */
  private _ownFor(
    flow: Flow,
    text: string,
    parent: Element,
    side: 0 | 1,
    next: Element | undefined,
    attrs: Record<string, Json> | undefined,
  ): Record<string, Json> | undefined {
    const rules = this._rulesOf(flow);
    if (!attrs) return undefined;
    const cut = rules ? cutIn(text, rules.opaque) : text.length;
    if (!rules || cut === 0) {
      let own: Record<string, Json> | undefined;
      for (const key in attrs)
        if (attrs[key] !== null) (own ??= {})[key] = attrs[key]!;
      return own;
    }
    const left =
      side === 1
        ? this._effAt(parent)
        : parent.off > 0
          ? this._effAt({ run: parent.run, off: parent.off - 1 })
          : this._effAt(this._originOf(parent.run));
    const inherited = withInherited(
      rules,
      undefined,
      left,
      this._effAt(next),
    ).attrs;
    let own: Record<string, Json> | undefined;
    for (const key in attrs) {
      const value = attrs[key]!;
      if (value === null) continue;
      const was = Object.hasOwn(inherited, key) ? inherited[key] : undefined;
      // Letters after an opaque one have their own state only: they say all.
      if (was !== undefined && sameValue(was, value) && cut === text.length)
        continue;
      (own ??= {})[key] = value;
    }
    for (const key in inherited) {
      const value = attrs && Object.hasOwn(attrs, key) ? attrs[key] : null;
      if (value === null || value === undefined) (own ??= {})[key] = null;
    }
    return own;
  }

  // ----- reading ---------------------------------------------------------

  textOf(node: string): string {
    let text = "";
    const root = this._roots.get(node);
    if (!root) return text;
    for (let run = root.next; run; run = run.next)
      if (!run.deleted) text += run.text;
    return text;
  }

  spansOf(node: string): TextSpan[] {
    const out: TextSpan[] = [];
    const root = this._roots.get(node);
    if (!root) return out;
    let key = "";
    for (let run = root.next; run; run = run.next) {
      if (run.deleted) continue;
      let at = 0;
      for (const [length, attrs] of this._effParts(run)) {
        const text =
          at === 0 && length === run.len
            ? run.text
            : run.text.slice(at, at + length);
        at += length;
        if (out.length > 0 && attrs.key === key)
          out[out.length - 1]!.text += text;
        else {
          out.push({ text, attrs: { ...attrs.attrs } });
          key = attrs.key;
        }
      }
    }
    return out;
  }

  /** The visible length of a node's text. */
  lengthOf(node: string): number {
    const root = this._roots.get(node);
    if (!root) return 0;
    return this._positions.length(root);
  }

  /** The id of the visible letter at `index` of a node's text. */
  letterAt(node: string, index: number): string | undefined {
    if (index < 0) return undefined;
    const found = this._seek(node, index);
    if (typeof found === "number") return undefined;
    return id(found.run.s, found.run.c + found.off);
  }

  /**
   * How many visible letters of a node's text are before letter `letter`,
   * deleted or not. Undefined when the text has no such letter.
   */
  indexOfLetter(node: string, letter: string): number | undefined {
    const parts = /^(.*):(\d+)$/s.exec(letter);
    if (!parts) return undefined;
    const c = Number(parts[2]);
    const run = this._runAt(parts[1]!, c);
    const root = this._roots.get(node);
    if (!run || !root) return undefined;
    if (run.flow !== root.flow) return undefined;
    return this._positions.before(root, run) + (run.visible ? c - run.c : 0);
  }

  /** The visible element at `index` of the node's text, or the text length. */
  protected _seek(node: string, index: number): Seek<Run> | number {
    const root = this._roots.get(node);
    if (!root) return 0;
    const length = this._positions.length(root);
    return index < length ? this._positions.seek(root, index) : length;
  }

  // ----- local operations ---------------------------------------------------

  private _record(doc: Doc, operation: TextEdit, inverse: TextInverse): void {
    doc["_operations"][0].push(operation);
    doc["_inverseOperations"][0].push(inverse);
    doc["_hasEdits"] = true;
  }

  private _commit(doc: Doc, payload: TextEdit): void {
    const inverse = this.apply(doc, payload);
    /* v8 ignore if -- @preserve: a write that loses to one of another
       replica with the same session and lamport (a generator that gives two
       replicas one session). */
    if (inverse === undefined) return;
    this._record(doc, payload, inverse);
  }

  /** Inserts letters typed here, a child of `parent` on `side` before `next`. */
  private _commitInsert(
    doc: Doc,
    text: string,
    parent: Element,
    side: 0 | 1,
    next: Element | undefined,
    attrs: Record<string, Json> | undefined,
  ): void {
    const [s, c] = this._mint(doc, text.length);
    const payload = encodeInsert(s, c, text, parent, side, next, attrs);
    const state = initialState(payload[3]);
    const run = new Run(
      s,
      c,
      text,
      parent.run.s,
      parent.run.c + parent.off,
      side,
      next?.run.s,
      next ? next.run.c + next.off : 0,
    );
    run.state = state;
    this._ensureKids();
    const touched: Run[] = [];
    const inverse = this._insertRun(run, parent, touched);
    this._settle(doc, touched);
    this._record(doc, payload, inverse);
  }

  /**
   * `insertLetters`, at a visible index. `attrs`: the state the letters
   * have, else what they inherit (see `InheritRules`).
   */
  insert(
    doc: Doc,
    node: string,
    index: number,
    text: string,
    attrs?: Record<string, Json>,
  ): void {
    if (attrs && Object.hasOwn(attrs, DELETED)) throw deletedKey();
    if (text.length === 0) return;
    const left = this._leftOf(node, index);
    const [parent, side] = this._parentFor(left);
    const next = this._nextOf(left);
    const own = this._ownFor(left.run.flow, text, parent, side, next, attrs);
    this._commitInsert(doc, text, parent, side, next, own);
  }

  /**
   * The element right before visible `index`, clamped to the text and moved
   * off the middle of a surrogate pair. The node's root for index 0, as if
   * it were the visible letter at -1.
   */
  private _leftOf(node: string, index: number): Seek<Run> {
    const root = this._rootOf(node);
    const start = { run: root, off: 0, before: -1 };
    if (index <= 0) return start;
    const length = this._positions.length(root);
    if (index > length) {
      if (length === 0) return start;
      return this._positions.seek(root, length - 1);
    }
    const left = this._positions.seek(root, index - 1);
    if (
      index === length ||
      !isHighSurrogate(left.run.text.charCodeAt(left.off))
    )
      return left;
    const right = this._positions.seek(root, index);
    if (isLowSurrogate(right.run.text.charCodeAt(right.off))) return right;
    return left;
  }

  private _nextOf(element: Element): Element | undefined {
    if (element.off < element.run.len - 1)
      return { run: element.run, off: element.off + 1 };
    return element.run.next ? { run: element.run.next, off: 0 } : undefined;
  }

  /** The Fugue rule: right child of the left element, or left child of the next one. */
  private _parentFor(left: Element): [Element, 0 | 1] {
    if (!this._hasRightChild(left.run, left.off)) return [left, 1];
    return [this._nextOf(left)!, 0];
  }

  /** `index` clamped to the text and moved off the middle of a surrogate pair. */
  private _boundary(node: string, index: number): number {
    const left = this._leftOf(node, index);
    return left.before + left.off + 1;
  }

  /** `setLetterState` of `DELETED` on a visible range. */
  delete(doc: Doc, node: string, index: number, length: number): void {
    const from = this._boundary(node, index);
    const to = this._boundary(node, index + length);
    if (to <= from) return;
    const root = this._rootOf(node);
    const first = this._positions.seek(root, from);
    const [s, c] = this._mint(doc, 0);
    this._ensureKids();
    // Deleting needs no new lamport: it wins over the undos it saw at theirs.
    const lamport = this._deletes;
    const touched: Run[] = [];
    const ranges: [string, number, number][] = [];
    let letters = "";
    let remaining = to - from;
    let off = first.off;
    for (let run = first.run; remaining > 0; run = run.next!) {
      if (!run.visible) continue;
      if (off > 0) run = this._split(run, off);
      if (run.len > remaining) this._split(run, remaining);
      this._setDeleted(run, true, lamport);
      touched.push(run);
      pushRange(ranges, run.s, run.c, run.len);
      letters += run.text;
      remaining -= run.len;
      off = 0;
    }
    this._settle(doc, touched);
    const encoded = encodeRanges(s, ranges);
    const payload: DeleteEdit = [3, TAG_DELETE, s, c, encoded];
    if (lamport > 0) payload.push(lamport);
    this._record(doc, payload, [3, TAG_DELETE, s, c, encoded, 0, letters]);
  }

  /**
   * Writes `DELETED` on `run`, where it wins: `deleted`, at `lamport`.
   * Returns 2 if the letters were visible and are not, or the other way, 1
   * if only the stamp changed, else 0.
   */
  private _setDeleted(run: Run, deleted: boolean, lamport: number): number {
    const current = run.state?.[DELETED];
    const was = current ? current[1] : run.deleted ? 0 : -1;
    if (deleted ? lamport < was : lamport <= was) return 0;
    // Deleted at lamport 0 says nothing more (see `DELETED`): it is the
    // first write, there was no stamp before.
    if (!deleted || lamport > 0)
      run.state = { ...run.state, [DELETED]: [deleted, lamport, ""] };
    if (run.deleted === deleted) return 1;
    run.deleted = deleted;
    this._positions.changed(run);
    return 2;
  }

  /**
   * `setLetterState` of a visible range. `value: null` removes the key. The
   * letters that inherited the key from the range keep what they had.
   */
  format(
    doc: Doc,
    node: string,
    from: number,
    to: number,
    key: string,
    value: Json,
  ): void {
    if (key === DELETED) throw deletedKey();
    from = this._boundary(node, from);
    to = this._boundary(node, to);
    if (to <= from) return;
    const root = this._rootOf(node);
    const ranges: [string, number, number][] = [];
    let remaining = to - from;
    const first = this._positions.seek(root, from);
    let off = first.off;
    for (let run = first.run; remaining > 0; run = run.next!) {
      if (!run.visible) continue;
      const take = Math.min(run.len - off, remaining);
      pushRange(ranges, run.s, run.c + off, take);
      remaining -= take;
      off = 0;
    }
    const rules = this._rulesOf(root.flow);
    const [s, c] = this._mint(doc, 0);
    const lamport = ++this._lamport;
    const encoded = encodeRanges(s, ranges);
    const pins =
      rules?.get(key) !== undefined
        ? this._pinsFor(root, rules, key, value, lamport, s, ranges)
        : [];
    // Pins (the groups after the first) are at lamport 0: those that start
    // right after the group before say so with where they start (see
    // `CONTINUES`), the others with `-lamport`.
    const groups: Json[] = [];
    let previous = ranges.at(-1)!;
    let marked = true;
    for (const [pinValue, pinRanges] of pins) {
      const continued = startsAfter(previous, pinRanges[0]!);
      marked &&= continued;
      groups.push(encodeRanges(s, pinRanges, continued ? c : -1), pinValue);
      previous = pinRanges.at(-1)!;
    }
    const payload: StateEdit = [
      3,
      TAG_STATE,
      s,
      c,
      marked ? lamport : -lamport,
      key,
      encoded,
    ];
    if (value !== null || pins.length > 0) payload.push(value);
    payload.push(...groups);
    if (payload.at(-1) === null) payload.pop();
    this._commit(doc, payload);
  }

  /**
   * The letters outside `ranges` that inherit `key` from them, by what they
   * have now: a write of `value` there would change it. They are written
   * what they have, at lamport 0, so that any other write wins over it.
   */
  private _pinsFor(
    root: Run,
    rules: Rules,
    key: string,
    value: Json,
    lamport: number,
    session: string,
    ranges: [string, number, number][],
  ): [Json, [string, number, number][]][] {
    const head = (run: Run) => Math.min(this._cutOf(run, rules), run.len);
    // What each run has before the try, kept on it (`Run.saved`).
    const token = ++this._tries;
    for (let run = root.next; run; run = run.next)
      if (head(run) > 0) {
        const eff = this._effOf(run);
        const d = derived(run);
        d.saved = eff;
        d.savedAt = token;
      }
    // The write, tried and taken back: `apply` makes it.
    const written = new Map<Run, LetterState | undefined>();
    const stamped: Stamped = [value, lamport, session];
    for (const [rs, rc, len] of ranges)
      this._forRange(rs, rc, len, (run) => {
        written.set(run, run.state);
        run.state = { ...run.state, [key]: stamped };
      });
    this._epoch++;
    const groups = new Map<string, [Json, [string, number, number][]]>();
    let was: Json | undefined;
    for (let run = root.next; run; run = run.next) {
      // A run split by the write is after the one it was cut from.
      if (run.d?.savedAt === token) was = run.d.saved!.attrs[key];
      const length = head(run);
      if (written.has(run) || length === 0) continue;
      const now = this._effOf(run).attrs[key];
      if (sameValue(now ?? null, was ?? null)) continue;
      const pin = was ?? null;
      const index = JSON.stringify(pin);
      let group = groups.get(index);
      if (!group) groups.set(index, (group = [pin, []]));
      pushRange(group[1], run.s, run.c, length);
    }
    for (const [run, state] of written) run.state = state;
    // What the runs had before the try is theirs again, without computing.
    const epoch = ++this._epoch;
    for (let run = root.next; run; run = run.next) {
      // Every run has one: `head` looked at each.
      const d = derived(run);
      const saved = d.savedAt === token;
      d.eff = saved ? d.saved : undefined;
      d.effAt = saved ? epoch : -1;
      d.saved = undefined;
    }
    return [...groups.values()].sort(
      ([a], [b]) => Number(a === null) - Number(b === null),
    );
  }

  /**
   * What an undo of the history applies: a new stamp, so that it wins over
   * what it undoes. Deleting again takes the lamport it is at (see
   * `DELETED`), bringing letters back a new one.
   */
  prepareUndo(doc: Doc, undo: TextInverse): TextInverse {
    if (undo[1] === TAG_STATE) {
      const [s, c] = this._mint(doc, 0);
      const own = undo[2];
      const out: StateEdit = [3, TAG_STATE, s, c, ++this._lamport, undo[5]];
      for (let at = 6; at < undo.length; at += 2) {
        out.push(encodeRanges(s, decodeRanges(own, undo[at]!)[0]));
        if (at + 1 < undo.length) out.push(undo[at + 1]!);
      }
      return out;
    }
    const out: DeleteEdit = [3, TAG_DELETE, undo[2], undo[3], undo[4]];
    if (typeof undo[6] === "string") out.push(++this._deletes, undo[6]);
    else if (this._deletes > 0) out.push(this._deletes);
    return out;
  }

  // ----- applying operations ---------------------------------------------

  apply(doc: Doc, payload: TextEdit): EditResult {
    this._ensureKids();
    const touched: Run[] = [];
    const result = this._applyRaw(doc, payload, touched);
    if (result === PENDING) {
      this._pending.push(payload);
      return undefined;
    }
    this._settle(doc, touched);
    return result;
  }

  private _settle(doc: Doc, touched: Run[]): void {
    if (this._pending.length > 0) this._drainPending(doc, touched);
    for (const run of touched) this._report(doc, run.flow.head.s);
    this._joinAround(touched);
    const cut = this._cut;
    if (cut.length > 0) {
      this._cut = [];
      this._joinAround(cut);
    }
  }

  private _joinAround(runs: Iterable<Run>): void {
    for (let run of runs) {
      if (run.prev && run.prev.next !== run) continue;
      while (run.prev && this._mergeable(run.prev, run)) run = run.prev;
      while (run.next && this._mergeable(run, run.next))
        this._absorb(run, run.next);
    }
  }

  private _absorb(left: Run, run: Run): void {
    left.text += run.text;
    const next = run.next;
    left.next = next;
    if (next) next.prev = left;
    else left.flow.tail = left;
    this._removeKid(run);
    this._index.get(run.s)!.remove(run);
    this._positions.removed(run);
    this._positions.changed(left);
    // Its letters are `left`'s now: a lookup kept on it misses (see `holds`).
    run.text = "";
  }

  private _drainPending(doc: Doc, touched: Run[]): void {
    let progressed = true;
    while (progressed && this._pending.length > 0) {
      progressed = false;
      const rest: TextEdit[] = [];
      for (const payload of this._pending) {
        const result = this._applyRaw(doc, payload, touched);
        if (result === PENDING) rest.push(payload);
        else progressed = true;
      }
      this._pending = rest;
    }
  }

  private _applyRaw(
    doc: Doc,
    payload: TextEdit,
    touched: Run[],
  ): EditResult | typeof PENDING {
    if (payload[1] === TAG_DELETE)
      return this._applyDelete(doc, payload, touched);
    if (payload[1] === TAG_STATE)
      return this._applyState(doc, payload, touched);
    // Letters of this replica's session that it has not written yet come
    // from another replica with the same session (see `NodeIds`).
    if (
      payload[1] === this._session &&
      payload[2] + lettersOf(payload[3]).length > this._counter
    )
      doc["_renewSession"]();
    return this._applyInsert(payload, touched);
  }

  private _applyInsert(
    payload: InsertEdit,
    touched: Run[],
  ): EditResult | typeof PENDING {
    const [, s, , content] = payload;
    let [, , c, , right, parent] = payload;
    let text = lettersOf(content);
    if (text === "") return undefined;
    const state = initialState(content);
    // Inserts typed one after the other arrive fused, sometimes on top of
    // inserts this replica already applied: the known prefix is skipped.
    let known = 0;
    if (c < (this._index.get(s)?.end() ?? 0)) {
      while (known < text.length) {
        const found = this._find(s, c + known);
        if (!found) break;
        known += found.run.len - found.off;
      }
      if (known >= text.length) return undefined;
      if (known > 0) {
        c += known;
        text = text.slice(known);
      }
    }
    const leftOfRight = typeof right === "number" && right < 0;
    if (typeof right === "number") right = Math.abs(right);
    const [rs, rc] =
      right === undefined || right === 0 ? [undefined, 0] : decodeRef(s, right);
    let ps: string;
    let pc: number;
    let side: 0 | 1 = 1;
    parent = known > 0 ? undefined : leftOfRight ? 0 : parent;
    if (parent === undefined) {
      ps = s;
      pc = c - 1;
    } else if (parent === 0) {
      [ps, pc] = [rs!, rc];
      side = 0;
    } else {
      [ps, pc] = decodeRef(s, parent);
    }
    const parentElement = this._locate(ps, pc);
    if (!parentElement) return PENDING;
    if (rs !== undefined && !this._locate(rs, rc)) return PENDING;
    const run = new Run(s, c, text, ps, pc, side, rs, rc);
    run.state = state;
    return this._insertRun(run, parentElement, touched);
  }

  /** Adds a new run, a child of `parent`. Returns the insert's inverse. */
  private _insertRun(run: Run, parent: Element, touched: Run[]): DeleteEdit {
    const { s, c } = run;
    const len = run.len;
    let placed = run;
    if (this._canExtend(parent, run)) {
      placed = parent.run;
      placed.text += run.text;
      placed.flow.dirty = true;
      this._positions.changed(placed);
    } else {
      this._indexRun(run);
      this._place(run, parent);
    }
    touched.push(placed);
    // No run crosses a multiple of `RUN_CAP`: whatever order letters came in,
    // runs end at the same places, and none is a string too long to edit.
    for (
      let boundary = (Math.floor(c / RUN_CAP) + 1) * RUN_CAP;
      boundary < c + len;
      boundary += RUN_CAP
    ) {
      placed = this._split(placed, boundary - placed.c);
      touched.push(placed);
    }
    return [3, TAG_DELETE, s, c, encodeRange(s, s, c, len)];
  }

  private _canExtend(parent: Element, run: Run): boolean {
    const left = parent.run;
    return (
      left.c !== -1 &&
      run.side === 1 &&
      !left.deleted &&
      left.s === run.s &&
      parent.off === left.len - 1 &&
      left.c + left.len === run.c &&
      left.rs === run.rs &&
      left.rc === run.rc &&
      run.c % RUN_CAP !== 0 &&
      sameState(left.state, run.state) &&
      !this._hasRightChild(left, parent.off)
    );
  }

  /** Runs `callback` over runs covering exactly the given known range. */
  private _forRange(
    s: string,
    c: number,
    len: number,
    callback: (run: Run) => void,
  ): void {
    let cursor = c;
    let remaining = len;
    while (remaining > 0) {
      const found = this._find(s, cursor)!;
      let run = found.run;
      if (found.off > 0) run = this._split(run, found.off);
      if (run.len > remaining) this._split(run, remaining);
      callback(run);
      remaining -= run.len;
      cursor += run.len;
    }
  }

  private _rangesKnown(ranges: readonly [string, number, number][]): boolean {
    for (const [s, c, len] of ranges) {
      let cursor = c;
      let remaining = len;
      while (remaining > 0) {
        const found = this._find(s, cursor);
        if (!found) return false;
        const available = found.run.len - found.off;
        remaining -= available;
        cursor += available;
      }
    }
    return true;
  }

  /**
   * `setLetterState` of `DELETED`: `[1, session, counter, ranges, lamport?,
   * text?]`. With `text`, the letters of the ranges, it brings them back.
   */
  private _applyDelete(
    doc: Doc,
    payload: DeleteEdit,
    touched: Run[],
  ): EditResult | typeof PENDING {
    const [, , s, c, encodedRanges, lamport = 0, letters] = payload;
    const [ranges] = decodeRanges(s, encodedRanges);
    if (!this._rangesKnown(ranges)) return PENDING;
    if (lamport > this._deletes) this._deletes = lamport;
    const revive = typeof letters === "string";
    const undo = !doc["_transactionFlags"].skipUndo;
    const changed: [string, number, number][] = [];
    let text = "";
    let at = 0;
    for (const [rs, rc, len] of ranges) {
      this._forRange(rs, rc, len, (run) => {
        // A replica that loaded the tombstones has no letters for them.
        if (revive) run.text = letters.slice(at, at + run.len);
        at += run.len;
        const result = this._setDeleted(run, !revive, lamport);
        if (result === 0) return;
        touched.push(run);
        if (result === 1 || !undo) return;
        pushRange(changed, run.s, run.c, run.len);
        if (!revive) text += run.text;
      });
    }
    if (touched.length === 0) return undefined;
    if (!undo || changed.length === 0) return [3, TAG_DELETE, s, c, 0];
    const inverse: DeleteEdit = [3, TAG_DELETE, s, c, encodeRanges(s, changed)];
    if (!revive) inverse.push(0, text);
    return inverse;
  }

  /**
   * `setLetterState`: `[2, session, counter, lamport, key, ranges, value?,
   * ...]`. A negative lamport writes the groups after the first at lamport
   * 0 (see `format`).
   */
  private _applyState(
    doc: Doc,
    payload: StateEdit,
    touched: Run[],
  ): EditResult | typeof PENDING {
    const [, , s, c, signed, key] = payload;
    const lamport = Math.abs(signed);
    const groups: [
      ranges: [string, number, number][],
      value: Json,
      weak: boolean,
    ][] = [];
    let previous: [string, number, number] | undefined;
    for (let at = 6; at < payload.length; at += 2) {
      const [ranges, continued] = decodeRanges(s, payload[at]!, c, previous);
      if (!this._rangesKnown(ranges)) return PENDING;
      const value = at + 1 < payload.length ? payload[at + 1]! : null;
      groups.push([ranges, value, at > 6 && (signed < 0 || continued)]);
      previous = ranges.at(-1);
    }
    if (lamport > this._lamport) this._lamport = lamport;
    const skipUndo = doc["_transactionFlags"].skipUndo;
    // The runs it writes, and what they had (with what they inherited).
    const writes: [Run, Stamped][] = [];
    for (const [ranges, value, weak] of groups) {
      const stamped: Stamped = [value, weak ? 0 : lamport, s];
      for (const [rs, rc, len] of ranges)
        this._forRange(rs, rc, len, (run) => {
          const current = run.state?.[key];
          if (current && !wins(stamped[1], s, current)) return;
          writes.push([run, stamped]);
        });
    }
    if (writes.length === 0) return undefined;
    const old = new Map<string, [Json, [string, number, number][]]>();
    if (!skipUndo)
      for (const [run] of writes) {
        let at = run.c;
        for (const [length, attrs] of this._effParts(run)) {
          const was = attrs.attrs[key] ?? null;
          const index = JSON.stringify(was);
          let entry = old.get(index);
          if (!entry) old.set(index, (entry = [was, []]));
          pushRange(entry[1], run.s, at, length);
          at += length;
        }
      }
    // Runs that had one state share the new one: fewer to compare and store.
    const next = new Map<Stamped, Map<LetterState | undefined, LetterState>>();
    for (const [run, stamped] of writes) {
      let byOld = next.get(stamped);
      if (!byOld)
        next.set(
          stamped,
          (byOld = new Map<LetterState | undefined, LetterState>()),
        );
      let state = byOld.get(run.state);
      if (!state)
        byOld.set(run.state, (state = { ...run.state, [key]: stamped }));
      run.state = state;
      touched.push(run);
    }
    this._epoch++;
    const inverse: StateEdit = [3, TAG_STATE, s, c, 0, key];
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

  /** `[11, sessions, text, columns, ...rest]` (see `toStored`). */
  toJSON(): TextJson | 0 {
    const sessions = new SessionTable();
    const columns: { encode(): string }[] = [];
    const stored = this.toStored(sessions, columns);
    if (stored === 0) return 0;
    const [text, ...rest] = stored;
    return [FORMAT, sessions.table, text, joinColumns(columns), ...rest];
  }

  /**
   * `[text, keys?, values?, states?, pending?]`, or `0` when there is no
   * text, and its columns in `out`.
   *
   * - `text`: the letters of every live run, in list order.
   * - The columns: per list, its flags and its number of runs; per run, its
   *   shape (length and flags) and only the fields its position does not
   *   imply. Per list with state, the runs of each state, as `count, state`.
   * - `states`: each distinct state, `[key, value, lamport, session, ...]`
   *   by index in `keys`, `values` and the sessions.
   */
  toStored(
    sessions: SessionTable,
    out: { encode(): string }[],
  ): StoredText | 0 {
    const B = BITS;
    const sessionOf = (s: string) => sessions.index(s);
    const size = this._flows.length;
    const columns = Array.from(
      { length: COLUMNS },
      (_, field) =>
        new ColumnWriter(
          size,
          false,
          field === COLUMN.FLOW_FLAGS || field === COLUMN.SHAPES,
        ),
    );
    const column = (field: number) => columns[field]!;
    const shapeColumn = column(COLUMN.SHAPE);
    const nodeSessions = column(COLUMN.NODE_SESSION);
    const nodeClocks = column(COLUMN.NODE_CLOCK);
    const flowFlags = column(COLUMN.FLOW_FLAGS);
    const flowRuns = column(COLUMN.FLOW_RUNS);
    const stateRuns = column(COLUMN.STATE_RUNS);
    const fields = new FieldWriter();
    const writeId = (id: string) => {
      nodeSessions.push(sessions.node(id));
      nodeClocks.push(sessions.clock);
    };
    let lastRight: string | undefined;
    let lastRightCounter = 0;
    const keys = new Map<string, number>();
    const valueIndexes = new Map<Json, number>();
    const objectIndexes = new Map<string, number>();
    const values: Json[] = [];
    const states: number[][] = [];
    const stateIndexes = new Map<LetterState, number>();
    const stateByCanon = new Map<string, number>();
    const stateIndex = (state: LetterState | undefined): number => {
      if (!state) return 0;
      const known = stateIndexes.get(state);
      if (known !== undefined) return known;
      // States equal by value are one, found by a form kept between saves.
      const canon = canonOf(state);
      const same = stateByCanon.get(canon);
      if (same !== undefined) {
        stateIndexes.set(state, same);
        return same;
      }
      const flat: number[] = [];
      for (const key of Object.keys(state).sort()) {
        const [value, lamport, session] = state[key]!;
        let k = keys.get(key);
        if (k === undefined) keys.set(key, (k = keys.size));
        const object = typeof value === "object" && value !== null;
        const index = object ? JSON.stringify(value) : value;
        const indexes = object ? objectIndexes : valueIndexes;
        let v = indexes.get(index);
        if (v === undefined) {
          indexes.set(index, (v = values.length));
          values.push(value);
        }
        flat.push(k, v, lamport, session === "" ? -1 : sessionOf(session));
      }
      // Another state with this form would have had the same `canon`.
      states.push(flat);
      const index = states.length;
      stateIndexes.set(state, index);
      stateByCanon.set(canon, index);
      return index;
    };
    const texts: string[] = [];
    const shapeBits: number[] = [];
    const bitsIndex = new Int32Array(B.KEPT * 2).fill(-1);
    let curSession = 0;
    let curCounter = 0;
    let expectedKey: string | undefined;
    const flows = this._sortedFlows();
    let any = false;
    for (const flow of flows) {
      const head = flow.head;
      const opaque = this._opaqueOf(flow);
      if (!head.next) continue;
      any = true;
      const key = head.s;
      let flags = 0;
      if (expectedKey !== key) {
        flags |= FLOW.KEY;
        writeId(key);
      }
      expectedKey = flow.nextKey ??= nextId(key);
      let hasState = false;
      for (let run: Run | undefined = head.next; run; run = run.next)
        if (run.state) {
          hasState = true;
          break;
        }
      if (hasState) flags |= FLOW.STATES;
      flowFlags.push(flags);
      let runs = 0;
      let prevPlain = false;
      let prevS = "";
      let prevC = 0;
      let prevEnd = 0;
      let prevRs: string | undefined;
      let prevRc = 0;
      let backPlain = false;
      let backS = "";
      let backEnd = 0;
      let backRs: string | undefined;
      let backRc = 0;
      let runSession = "";
      let runIndex = 0;
      let lastState = -1;
      let stateCount = 0;
      for (let run: Run | undefined = head; run; run = run.next) {
        // Runs cut only at a multiple of `RUN_CAP` are stored as one, and
        // cut again when loaded.
        let last: Run = run;
        let text = run.text;
        if (run !== head)
          while (last.next && continues(last, last.next)) {
            last = last.next;
            text += last.text;
          }
        const s = run.s;
        const c = run.c;
        const length = text.length;
        const rs = run.rs;
        const rc = run.rc;
        if (run !== head) {
          runs++;
          const next = last.next;
          const ps = run.ps;
          const pc = run.pc;
          const side = run.side;
          const deleted = run.deleted;
          let bits = 0;
          if (length >= LONG) fields.write(length - LONG, CUT.LONG);
          const resumes =
            backPlain &&
            s === backS &&
            c === backEnd &&
            ps === backS &&
            pc === c - 1 &&
            side === 1;
          if (s !== runSession) {
            runSession = s;
            runIndex = sessionOf(s);
          }
          if (resumes) {
            bits |= B.RESUME;
            curSession = runIndex;
            curCounter = c + length;
          } else if (prevPlain && prevS === s && c + length === prevC) {
            bits |= B.BEFORE;
            curSession = runIndex;
            curCounter = prevC;
          } else {
            if (runIndex !== curSession) {
              bits |= B.SESSION;
              fields.write(runIndex, CUT.SESSION);
            }
            if (c !== curCounter) {
              bits |= B.COUNTER;
              fields.writeSigned(c - curCounter, CUT.COUNTER);
            }
            curSession = runIndex;
            curCounter = c + length;
          }
          const parentIsPrev = ps === prevS && pc === prevEnd - 1 && side === 1;
          if (resumes) {
            // Its parent is the end of `back`.
          } else if (side === 0 && ps === next?.s && pc === next?.c) {
            bits |= B.LEFT_OF_NEXT;
          } else if (!parentIsPrev) {
            bits |= B.PARENT;
            if (ps !== s) {
              bits |= B.PARENT_SESSION;
              fields.write(sessionOf(ps!), CUT.SESSION);
            }
            fields.writeSigned((pc - c) * 2 + side, CUT.PARENT);
          }
          const rightIsDefault = resumes
            ? rs === backRs && rc === backRc
            : side === 0
              ? rs === ps && rc === pc
              : next
                ? rs === next.s && rc === next.c
                : rs === undefined;
          if (!rightIsDefault) {
            if (rs === undefined) bits |= B.NO_RIGHT;
            else if (rs === lastRight && rc === lastRightCounter)
              bits |= B.SAME_RIGHT;
            else {
              bits |= B.RIGHT;
              if (rs !== s) {
                bits |= B.RIGHT_SESSION;
                fields.write(sessionOf(rs), CUT.SESSION);
              }
              fields.writeSigned(rc - lastRightCounter, CUT.RIGHT);
              lastRight = rs;
              lastRightCounter = rc;
            }
          }
          if (!deleted) texts.push(text);
          else {
            bits |= B.DELS;
            // Opaque letters stay opaque when deleted (see `Rules.opaque`):
            // they are kept, with how far each is from the one before.
            const kept = keptLetters(text, opaque);
            if (kept !== undefined) {
              bits |= B.KEPT;
              texts.push(kept[0]);
              fields.write(kept[1].length, CUT.COUNTER);
              let at = 0;
              for (const offset of kept[1]) {
                fields.write(offset - at, CUT.COUNTER);
                at = offset;
              }
            }
          }
          let shape = bitsIndex[bits]!;
          if (shape === -1) {
            shape = bitsIndex[bits] = shapeBits.length;
            shapeBits.push(bits);
          }
          shapeColumn.push(
            shape * (LONG + 1) + (length < LONG ? length : LONG),
          );
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
        }
        backPlain = prevPlain;
        backS = prevS;
        backEnd = prevEnd;
        backRs = prevRs;
        backRc = prevRc;
        prevPlain = c !== -1;
        prevS = s;
        prevC = c;
        // A node's root stands for counter -1: its first kid's parent.
        prevEnd = c === -1 ? 0 : c + length;
        prevRs = rs;
        prevRc = rc;
        run = last;
      }
      if (stateCount > 0) {
        stateRuns.push(stateCount);
        stateRuns.push(lastState);
      }
      flowRuns.push(runs);
    }
    const pending = this._pending
      .map(([, ...payload]) => JSON.stringify(payload))
      .sort();
    if (!any && pending.length === 0) return 0;
    const counts = shapeColumn.tally(shapeBits.length * (LONG + 1));
    const ranked: number[] = [];
    for (let shape = 0; shape < counts.length; shape++)
      if (counts[shape]) ranked.push(shape);
    ranked.sort((a, b) => counts[b]! - counts[a]! || a - b);
    const rank = new Int32Array(counts.length);
    const shapes = column(COLUMN.SHAPES);
    for (const [index, shape] of ranked.entries()) {
      rank[shape] = index;
      shapes.push(shape % (LONG + 1));
      shapes.push(shapeBits[Math.floor(shape / (LONG + 1))]!);
    }
    shapeColumn.remap(rank);
    out.push(
      ...columns.slice(0, COLUMN.FIELDS),
      fields,
      ...columns.slice(COLUMN.FIELDS),
    );
    // Keys and values come with the states that use them.
    const text = texts.join("");
    const keyList = [...keys.keys()];
    if (pending.length > 0) return [text, keyList, values, states, pending];
    return states.length > 0 ? [text, keyList, values, states] : [text];
  }

  private _sortedFlows(): readonly Flow[] {
    return (this._sorted ??= [...this._flows].sort((a, b) =>
      compareIds(a.head.s, a.head.c, b.head.s, b.head.c),
    ));
  }

  /** Whether `run`, right after `left`, only differs from it by how it was built. */
  private _mergeable(left: Run, run: Run): boolean {
    return (
      left.c !== -1 &&
      left.s === run.s &&
      left.c + left.text.length === run.c &&
      run.c % RUN_CAP !== 0 &&
      run.ps === run.s &&
      run.pc === left.c + left.text.length - 1 &&
      run.side === 1 &&
      left.rs === run.rs &&
      left.rc === run.rc &&
      left.deleted === run.deleted &&
      sameState(left.state, run.state)
    );
  }

  static fromJSON(json: TextJson | 0 | undefined): TextStore {
    const store = new TextStore();
    if (!Array.isArray(json)) return store;
    if (json[0] !== FORMAT)
      throw new Error(`Unsupported text format: ${JSON.stringify(json[0])}`);
    const [, table, text, columns, ...rest] = json;
    return store._readColumns(
      readSessions(table),
      [text, ...rest],
      splitColumns(columns),
    );
  }

  static fromStored(
    stored: StoredText,
    columns: string[],
    sessions: string[],
  ): TextStore {
    return new TextStore()._readColumns(sessions, stored, columns);
  }

  private _readColumns(
    sessions: string[],
    stored: StoredText,
    columns: string[],
  ): TextStore {
    const B = BITS;
    const [text, keys = [], values = [], states = [], pending = []] = stored;
    const sessionIndex = new Map(
      sessions.map((session, index) => [session, index]),
    );
    const texts = Array.from(
      { length: COLUMNS + 1 },
      (_, field) => columns[field] ?? "",
    );
    const fields = new FieldReader(texts[COLUMN.FIELDS]!);
    texts.splice(COLUMN.FIELDS, 1);
    const readers = texts.map((text) => new ColumnReader(text));
    const column = (field: number) => readers[field]!;
    const shapes = column(COLUMN.SHAPES);
    const shapeLengths: number[] = [];
    const shapeBits: number[] = [];
    while (!shapes.done) {
      shapeLengths.push(shapes.next());
      shapeBits.push(shapes.next());
    }
    const nodeSessions = column(COLUMN.NODE_SESSION);
    const nodeClocks = column(COLUMN.NODE_CLOCK);
    const readId = () =>
      joinId(sessions[nodeSessions.next()]!, nodeClocks.next());
    const decodedStates: (LetterState | undefined)[] = [undefined];
    for (const flat of states) {
      const state: Record<string, Stamped> = {};
      for (let at = 0; at < flat.length; at += 4) {
        const lamport = flat[at + 2]!;
        const session = flat[at + 3]!;
        state[keys[flat[at]!]!] = [
          values[flat[at + 1]!]!,
          lamport,
          session === -1 ? "" : sessions[session]!,
        ];
        if (keys[flat[at]!] === DELETED) {
          if (lamport > this._deletes) this._deletes = lamport;
        } else if (lamport > this._lamport) this._lamport = lamport;
      }
      decodedStates.push(state);
    }
    let lastRight: string | undefined;
    let lastRightCounter = 0;
    const bySession = new Map<string, Run[]>();
    let position = 0;
    let curSession = 0;
    let curCounter = 0;
    let previousKey: string | undefined;
    const flowFlags = column(COLUMN.FLOW_FLAGS);
    const flowRuns = column(COLUMN.FLOW_RUNS);
    const runShapes = column(COLUMN.SHAPE);
    const stateRuns = column(COLUMN.STATE_RUNS);
    while (!flowFlags.done) {
      const flags = flowFlags.next();
      const key = flags & FLOW.KEY ? readId() : nextId(previousKey!)!;
      previousKey = key;
      const root = this._rootOf(key);
      const flow = root.flow;
      let prev: Run = root;
      let back: Run | undefined;
      let waiting: Run | undefined;
      let waits = 0;
      let stateLeft = 0;
      let state: LetterState | undefined;
      const push = (run: Run, runWaits: number) => {
        if (waiting) {
          if (waits & 1) {
            waiting.ps = run.s;
            waiting.pc = run.c;
          }
          if (waits & 2) {
            waiting.rs = waiting.side === 0 ? waiting.ps : run.s;
            waiting.rc = waiting.side === 0 ? waiting.pc : run.c;
          }
        }
        waiting = run;
        waits = runWaits;
        run.flow = flow;
        run.prev = prev;
        prev.next = run;
        back = prev;
        prev = run;
      };
      for (let left = flowRuns.next(); left > 0; left--) {
        const shape = runShapes.next();
        const bits = shapeBits[shape]!;
        let length = shapeLengths[shape]!;
        if (length === LONG) length += fields.read(CUT.LONG);
        const resumed = bits & B.RESUME ? back! : undefined;
        let s: string;
        let c: number;
        if (resumed) {
          s = resumed.s;
          c = resumed.c + resumed.text.length;
          curSession = sessionIndex.get(s)!;
          curCounter = c + length;
        } else if (bits & B.BEFORE) {
          s = prev.s;
          c = prev.c - length;
          curSession = sessionIndex.get(s)!;
          curCounter = prev.c;
        } else {
          if (bits & B.SESSION) curSession = fields.read(CUT.SESSION);
          if (bits & B.COUNTER) curCounter += fields.readSigned(CUT.COUNTER);
          s = sessions[curSession]!;
          c = curCounter;
          curCounter += length;
        }
        let ps: string | undefined = prev.s;
        let pc = prev.c === -1 ? -1 : prev.c + prev.text.length - 1;
        let side: 0 | 1 = 1;
        if (resumed) {
          ps = s;
          pc = c - 1;
        } else if (bits & B.PARENT) {
          ps =
            bits & B.PARENT_SESSION ? sessions[fields.read(CUT.SESSION)]! : s;
          const code = fields.readSigned(CUT.PARENT);
          side = (code & 1) as 0 | 1;
          pc = c + (code - side) / 2;
        } else if (bits & B.LEFT_OF_NEXT) side = 0;
        let rs: string | undefined;
        let rc = 0;
        const defaultRight = !(bits & (B.RIGHT | B.NO_RIGHT | B.SAME_RIGHT));
        if (bits & B.RIGHT) {
          rs = bits & B.RIGHT_SESSION ? sessions[fields.read(CUT.SESSION)]! : s;
          rc = lastRightCounter + fields.readSigned(CUT.RIGHT);
          lastRight = rs;
          lastRightCounter = rc;
        } else if (bits & B.SAME_RIGHT) {
          rs = lastRight;
          rc = lastRightCounter;
        } else if (defaultRight && resumed) {
          rs = resumed.rs;
          rc = resumed.rc;
        } else if (defaultRight && side === 0 && !(bits & B.LEFT_OF_NEXT)) {
          rs = ps;
          rc = pc;
        }
        const run = new Run(s, c, "", ps, pc, side, rs, rc);
        run.deleted = (bits & B.DELS) !== 0;
        if (bits & B.KEPT) {
          let letters = "";
          let at = 0;
          for (let left = fields.read(CUT.COUNTER); left > 0; left--) {
            const offset = at + fields.read(CUT.COUNTER);
            const letter = String.fromCodePoint(text.codePointAt(position)!);
            position += letter.length;
            letters += DELETED_LETTER.repeat(offset - letters.length) + letter;
            at = offset;
          }
          run.text = letters + DELETED_LETTER.repeat(length - letters.length);
        } else if (run.deleted) run.text = DELETED_LETTER.repeat(length);
        else {
          run.text = text.slice(position, position + length);
          position += length;
        }
        if (flags & FLOW.STATES) {
          if (stateLeft === 0) {
            stateLeft = stateRuns.next();
            state = decodedStates[stateRuns.next()];
          }
          stateLeft--;
          run.state = state;
        }
        const runs = bySession.get(s);
        if (runs) runs.push(run);
        else bySession.set(s, [run]);
        const parentWaits = bits & B.LEFT_OF_NEXT ? 1 : 0;
        push(
          run,
          parentWaits |
            (defaultRight && !resumed && (side === 1 || parentWaits) ? 2 : 0),
        );
      }
      flow.tail = prev;
      // Cut where `_insertRun` cuts (see `toStored`).
      for (let run = root.next; run; run = run.next)
        for (
          let boundary = (Math.floor(run.c / RUN_CAP) + 1) * RUN_CAP;
          boundary < run.c + run.text.length;
          boundary += RUN_CAP
        ) {
          run = cutAt(run, boundary - run.c);
          bySession.get(run.s)!.push(run);
        }
    }
    for (const [session, runs] of bySession)
      this._index.set(session, SessionRuns.from(runs));
    this._kidsReady = false;
    // Each one as `toStored` wrote it: its payload after the kind.
    // TODO: to be decided. The cast trusts the stored document, like the rest
    // of `Doc.fromJSON`. Storing pending edits as arrays instead of JSON
    // strings would remove it (a format change).
    for (const payload of pending)
      this._pending.push([3, ...(JSON.parse(payload) as StoredEdit)]);
    return this;
  }

  /** Builds the kid lists of a loaded store from its lists. */
  private _ensureKids(): void {
    if (this._kidsReady) return;
    this._kidsReady = true;
    for (const flow of this._flows)
      for (let run: Run | undefined = flow.head; run; run = run.next)
        if (run.ps !== undefined) {
          const bySession = this._kidsIn(run.side, run.ps);
          const list = kidsAt(bySession, run.pc);
          if (list) list.push(run);
          else setKidsAt(bySession, run.pc, [run]);
        }
  }

  // ----- test inspection ---------------------------------------------------

  /** The runs of each list, in order: a tombstone is a `-` per letter. */
  protected _debugRuns(): string[][] {
    return this._sortedFlows().map((flow) => {
      const runs: string[] = [];
      for (let run = flow.head.next; run; run = run.next)
        runs.push(run.deleted ? "-".repeat(run.len) : run.text);
      return runs;
    });
  }

  protected _debugViews(): Record<string, string[]> {
    const views: Record<string, string[]> = {};
    for (const flow of this._flows) {
      const ids: string[] = [];
      for (let run = flow.head.next; run; run = run.next) {
        if (!run.visible) continue;
        for (let off = 0; off < run.len; off++)
          ids.push(id(run.s, run.c + off));
      }
      views[flow.head.s] = ids;
    }
    return views;
  }

  protected _debugElements(): {
    id: string;
    deleted: boolean;
    visible: boolean;
    leftOrigin: string | undefined;
    rightOrigin: string | undefined;
  }[] {
    const out: {
      id: string;
      deleted: boolean;
      visible: boolean;
      leftOrigin: string | undefined;
      rightOrigin: string | undefined;
    }[] = [];
    for (const flow of this._sortedFlows()) {
      for (let run = flow.head.next; run; run = run.next) {
        for (let off = 0; off < run.len; off++) {
          out.push({
            id: id(run.s, run.c + off),
            deleted: run.deleted,
            visible: run.visible,
            leftOrigin: this._leftOrigin({ run, off }),
            rightOrigin: run.rs === undefined ? undefined : id(run.rs, run.rc),
          });
        }
      }
    }
    return out;
  }

  /** Fugue paper, Lemma 8(a). */
  private _leftOrigin(element: Element): string | undefined {
    let { run, off } = element;
    while (true) {
      if (off > 0) return id(run.s, run.c + off - 1);
      // Letters always have a parent: the root, at least.
      if (run.side === 1) return id(run.ps!, run.pc);
      const parent = this._find(run.ps!, run.pc)!;
      run = parent.run;
      off = parent.off;
    }
  }
}

/** Whether `run` only continues `left`, cut from it at a multiple of `RUN_CAP`. */
const continues = (left: Run, run: Run) =>
  run.c % RUN_CAP === 0 &&
  run.s === left.s &&
  run.c === left.c + left.text.length &&
  run.ps === run.s &&
  run.pc === run.c - 1 &&
  run.side === 1 &&
  run.rs === left.rs &&
  run.rc === left.rc &&
  run.deleted === left.deleted &&
  sameState(run.state, left.state);

/** Cuts a run of a list being loaded at `offset`. Returns the new one. */
function cutAt(run: Run, offset: number): Run {
  const tail = new Run(
    run.s,
    run.c + offset,
    run.text.slice(offset),
    run.s,
    run.c + offset - 1,
    1,
    run.rs,
    run.rc,
  );
  run.text = run.text.slice(0, offset);
  tail.deleted = run.deleted;
  tail.state = run.state;
  tail.flow = run.flow;
  tail.prev = run;
  tail.next = run.next;
  if (run.next) run.next.prev = tail;
  else run.flow.tail = tail;
  run.next = tail;
  return tail;
}

/** Flags of a stored list. */
const FLOW = {
  /** Its node id is not the one right after the previous list's. */
  KEY: 1,
  /** Its runs have state (see `COLUMN.STATE_RUNS`). */
  STATES: 2,
};
/** Flags of a stored run. */
const BITS = {
  PARENT_SESSION: 1,
  SAME_RIGHT: 2,
  COUNTER: 4,
  RESUME: 8,
  LEFT_OF_NEXT: 16,
  RIGHT: 32,
  DELS: 64,
  NO_RIGHT: 128,
  SESSION: 256,
  PARENT: 512,
  RIGHT_SESSION: 1024,
  /** It ends where the run before starts, of its session: typed before it. */
  BEFORE: 2048,
  /** Deleted, with its opaque letters among placeholders in the text. */
  KEPT: 4096,
};
/** The columns of a stored text, the most common first. */
const COLUMN = {
  FLOW_FLAGS: 0,
  FLOW_RUNS: 1,
  SHAPE: 2,
  SHAPES: 3,
  /** The fields of the runs one after the other (see `CUT`). */
  FIELDS: 4,
  NODE_SESSION: 4,
  NODE_CLOCK: 5,
  /** Per list with state: `count, state` for each stretch of runs. */
  STATE_RUNS: 6,
};
const COLUMNS = 7;
const CUT = { LONG: 48, SESSION: 8, COUNTER: 40, PARENT: 40, RIGHT: 43 };
const LONG = 16;
/** Runs end at counters that are multiples of it (see `_insertRun`). */
const RUN_CAP = 4096;
/** The stored format this version writes (see `toJSON`). */
const FORMAT = 11;
/** Stands for a deleted letter of a stored text. */
const DELETED_LETTER = "�";

/**
 * The letters of a tombstone a stored text keeps, and where each is: its
 * opaque ones. Undefined when it has none. With `opaque` undefined (rules
 * not known), the letters a loaded text kept.
 */
function keptLetters(
  text: string,
  opaque: string | undefined,
): [string, number[]] | undefined {
  const keeps =
    opaque === undefined
      ? (letter: string) => letter !== DELETED_LETTER
      : (letter: string) => opaque.includes(letter);
  // Most tombstones have none: found without walking their letters.
  if (opaque === undefined ? !NOT_DELETED.test(text) : !hasAny(text, opaque))
    return undefined;
  let letters = "";
  const offsets: number[] = [];
  let at = 0;
  for (const letter of text) {
    if (keeps(letter)) {
      letters += letter;
      offsets.push(at);
    }
    at += letter.length;
  }
  return [letters, offsets];
}

const NOT_DELETED = /[^\ufffd]/;

function hasAny(text: string, letters: string): boolean {
  for (const letter of letters) if (text.includes(letter)) return true;
  return false;
}

// ----- wire format ---------------------------------------------------------
//
// One operation is the array after the `3` of an edit operation:
//
// - `insertLetters`: `[session, counter, text | [text, attrs], right?,
//   parent?]`. `attrs` is the letters' first state, below any write.
// - `setLetterState`: `[2, session, counter, lamport, key, ranges, value?,
//   ...]`, a value for each list of ranges, the last one `null` if left out.
//   The session is the writer's: with the lamport, it orders writes.
//   CONTINUES: a list of ranges after the first whose first letter is the
//   writer's at the operation's counter (a letter no range can name: the
//   operation mints none) starts right after the list before. Such a list
//   is written at lamport 0, as every list after the first is with a
//   negative lamport: the pins of `format`.
// - `setLetterState` of `DELETED`: `[1, session, counter, ranges, lamport?,
//   text?]` deletes the letters (lamport 0 if left out), or with `text`, their
//   letters, brings them back.
//
// Only an insert uses ids: the session and counter of the others are where
// their references count from, not new ids.
//
// A reference to an element is a number for one of the operation's own
// session (`counter + 1`), `session.counter` (base 64) for another one, and
// `^node` for the start of a node's text. `parent` omitted: the element right
// before (session, counter - 1). `parent` 0: left child of `right`.

const TAG_DELETE = 1;
const TAG_STATE = 2;

/**
 * `ranges`; with `continues`, the counter of its operation, the first one
 * starts right after the range before it and says so (see `CONTINUES`).
 */
function encodeRanges(
  own: string,
  ranges: [string, number, number][],
  continues = -1,
): Json {
  const ref = (index: number) => {
    const [s, c] = ranges[index]!;
    return index === 0 && continues >= 0
      ? encodeRef(own, own, continues)
      : encodeRef(own, s, c);
  };
  if (ranges.length === 1) {
    const len = ranges[0]![2];
    return len === 1 ? ref(0) : [ref(0), len];
  }
  const out: Json[] = [];
  for (const [index, [, , len]] of ranges.entries()) out.push(ref(index), len);
  return out;
}

/** Whether `range` starts right after `previous`, of the same session. */
const startsAfter = (
  previous: [string, number, number],
  range: [string, number, number],
) => range[0] === previous[0] && range[1] === previous[1] + previous[2];

/**
 * Letter ranges; a node's root, which no edit names, or an empty one is left
 * out. In a `setLetterState` (its counter `at`), a first range that names
 * the letter at `at` of the writer's session (`CONTINUES`) starts right
 * after `previous`: also returned, as whether it did.
 */
const decodeRanges = (
  own: string,
  flat: Json,
  at = -1,
  previous?: [string, number, number],
): [[string, number, number][], boolean] => {
  const out: [string, number, number][] = [];
  let continued = false;
  const push = (ref: Json, len: Json | undefined) => {
    if (typeof len !== "number" || len <= 0) return;
    let [s, c] = decodeRef(own, ref);
    // CONTINUES: no range names the letter its own operation would mint.
    if (out.length === 0 && s === own && c === at && previous) {
      [s, c] = [previous[0], previous[1] + previous[2]];
      continued = true;
    }
    if (c >= 0) out.push([s, c, len]);
  };
  const list = listOf(flat);
  if (!list) push(flat, 1);
  else
    for (let index = 0; index < list.length; index += 2)
      push(list[index]!, list[index + 1]);
  return [out, continued];
};

function encodeInsert(
  s: string,
  c: number,
  text: string,
  parent: Element,
  side: 0 | 1,
  next: Element | undefined,
  attrs: Record<string, Json> | undefined,
): InsertEdit {
  const payload: InsertEdit = [3, s, c, contentOf(text, attrs)];
  const nextRef = next ? encodeRef(s, next.run.s, next.run.c + next.off) : 0;
  const parentRef = encodeRef(s, parent.run.s, parent.run.c + parent.off);
  if (side === 0) {
    if (typeof nextRef === "number") payload.push(-nextRef);
    else payload.push(nextRef, 0);
  } else if (parent.run.s === s && parent.run.c + parent.off === c - 1) {
    if (nextRef !== 0) payload.push(nextRef);
  } else {
    payload.push(nextRef, parentRef);
  }
  return payload;
}
