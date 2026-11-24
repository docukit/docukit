import { Doc, type DocNode } from "../main.js";
import { clockAt, lastDot, numberToBase64 } from "../idGenerator.js";
import {
  compactOperations,
  onApplyOperations,
  parseStateKey,
  stringifyStateKey,
  type DraftOperations,
  type Operations,
  type OrderedOperation,
  type StatePatch,
} from "../operations.js";
import type {
  ChangeEvent,
  CrdtEngine,
  CrdtEngineFactory,
  Diff,
  Json,
  JsonDoc,
  JsonTree,
  TransactionFlags,
} from "../types.js";
import {
  compareStamps,
  detachRange,
  isList,
  isObjectEmpty,
  withTransaction,
} from "../utils.js";
import {
  decodeOperations,
  encodeOperations,
  list,
  num,
  text,
} from "../wire.js";
import {
  ColumnReader,
  ColumnWriter,
  frontCode,
  joinColumns,
  SessionTable,
  splitColumns,
} from "../columns.js";
import {
  columnsOf,
  elementsOf,
  sharedColumn,
  storedDoc,
  storedSessions,
} from "../jsonDoc.js";
import { IdRanges } from "../idRanges.js";
import { isRecord, storeOf, textState } from "../text/common.js";
import { applyLocal } from "./local.js";
import { TextStore } from "../text/store.js";
import { childIds, FugueSiblings, type Place } from "./fugue.js";
import {
  engineRow,
  readId,
  Sessions,
  textRows,
  withEngineRow,
  withoutEngineRow,
  writeId,
  type EngineRow,
} from "./wire.js";

export type CrdtOptions = {
  /** How the undo of a delete brings a node back. */
  undo?: "lives" | "newId";
  /**
   * Lamport ticks after which a replica removes for good the nodes its own
   * deletes left pending (a descendant a concurrent move could still rescue) and
   * its own inserts that fell under a deleted parent. Default 100.
   */
  gcDelay?: number;
};

/** `[lamport, session]`. Sorted by lamport, then session. */
type Stamp = readonly [number, string];

type Back = { parent: string; pos: string };

type Entry = {
  id: string;
  life: number;
  /** Undefined until its insert arrives. */
  type: string | undefined;
  /** The pointer of the last insert or move, and its stamp. */
  parent: string | undefined;
  pos: string;
  at: Stamp | undefined;
  /** Only if it was ever moved: where its author saw it before moving. */
  back: Back | undefined;
  stamps: Record<string, Stamp>;
  /** Stamp of the insert of this life: older state writes do not apply. */
  born: Stamp | undefined;
  /** Values that arrived before the insert. */
  pending: Record<string, string> | undefined;
  node: DocNode | undefined;
  /** The place where it is shown. */
  key: string;
  /** Whether others could point at it the last time it was placed. */
  alive: boolean;
  /**
   * Whether it is shown away from its place, after the nodes
   * placed in its parent (see `#prevSibling`).
   */
  away: boolean;
};

/** JSON has `null`, and the labels travel as JSON. */
// eslint-disable-next-line @typescript-eslint/no-restricted-types
type Nil = null;

const compare = (a: Stamp, b: Stamp) => compareStamps(a[0], a[1], b[0], b[1]);

/** The engine row of a record's fields, without the empty ones at the end. */
function recordRow(fields: Json[]): EngineRow {
  let length = fields.length;
  while (
    length > 1 &&
    (isEmpty(fields[length - 1]) || fields[length - 1] === 0)
  )
    length--;
  const row: [number, ...Json[]] = [RECORD];
  for (let at = 0; at < length; at++) {
    const field = fields[at]!;
    row.push(isEmpty(field) ? 0 : field);
  }
  return row;
}

/**
 * The labels of a transaction travel as an engine row (see `./wire.ts`):
 * `[3, lamport, inserts, moves, deletes, lives, pending, session]`, without
 * the empty ones (and a session 0) at the end, and an empty one in between as
 * `0`. The Lamport clock is written after the clock of the first node the
 * record inserts (see `firstClock`). The state
 * written goes in the batch's state patch, and text edits in its text rows.
 * `pending` names descendants of a deleted node that a concurrent move may
 * still take out of the deleted subtree. A whole stored document travels as
 * `[4, jsonDoc]`, as a replica sends it after a crash.
 */
const RECORD = 3;
const SNAPSHOT = 4;

type InsertRecord =
  | [id: string, type: string, pos: string]
  | [id: string, type: string, pos: string, life: number];
type InsertGroup = [parent: string | 0, ...nodes: InsertRecord[]];
type MoveBase = [
  id: string,
  parent: string | 0,
  pos: string,
  backParent: string | 0 | Nil,
  backPos: string | Nil,
];
type MoveRecord = MoveBase | [...MoveBase, life: number];
type DeleteRecord = [session: string, from: number, to: number, life: number];
type PendingRecord = [
  seenLamport: number,
  seenSession: string,
  ...range: DeleteRecord,
];

type LabelRecord = {
  lamport: number;
  session: string;
  inserts: InsertGroup[];
  moves: MoveRecord[];
  deletes: DeleteRecord[];
  lives: Record<string, number>;
  pending: PendingRecord[];
};

/** The id right after `id` in its session (see `encodeRecord`), if it has a clock. */
function nextId(id: string): string | undefined {
  const dot = lastDot(id);
  const clock = dot > 0 ? clockAt(id, dot) : -1;
  return clock < 0
    ? undefined
    : id.slice(0, dot + 1) + numberToBase64(clock + 1);
}

/**
 * The only place that writes the labels layout. Siblings are ordered by
 * places (see `FugueSiblings.writePlace`). An insert is `[id, type, origin?,
 * right?]`, or `[id, type, origin, right, life, place]` for a place that is
 * not the node's id, and a number after an insert is that many nodes after
 * it, each the id right after the one before and in its own place; a move is `[id, parent, place, origin?, right?]`, then
 * what `moveTail` writes. An `origin` of `false` names a place that travels
 * on its own.
 */
function encodeRecord(
  record: LabelRecord,
  sessions: Sessions,
  fugue: FugueSiblings,
): EngineRow {
  const ref = (id: string | 0) => (id === 0 ? 0 : sessions.write(id));
  const write = (id: string) => sessions.write(id);
  let previous: string | undefined;
  const placed = (row: Json[], pos: string, tail: Json[]) => {
    const written = fugue.writePlace(pos, previous, write);
    // A cut affirmed at a place that has not arrived here: it travels alone.
    if (!written) {
      row.push(false, 0, ...tail);
      return row;
    }
    const [origin, right] = written;
    previous = pos;
    if (tail.length > 0) row.push(origin, right, ...tail);
    else if (right !== 0) row.push(origin, right);
    else if (origin !== "") row.push(origin);
    return row;
  };
  const inserts: Json[] = [];
  for (const [parent, ...nodes] of record.inserts) {
    const group: Json[] = [ref(parent)];
    // A place that is not the node's id is written: a later life, or a node
    // inserted again with its life (an undo of a delete seen as hidden).
    const entries = nodes.map(([id, type, pos, life]) =>
      placed(
        [ref(id), type],
        pos,
        life || pos !== id ? [life ?? 0, write(pos)] : [],
      ),
    );
    // Nodes right after the one before, of its type and in their own
    // place, are a run: the first one's entry, then how many follow it.
    for (let at = 0; at < entries.length; ) {
      group.push(entries[at]!);
      let count = 0;
      while (
        at + count + 1 < entries.length &&
        entries[at + count + 1]!.length === 2 &&
        nodes[at + count + 1]![1] === nodes[at]![1] &&
        nodes[at + count + 1]![0] === nextId(nodes[at + count]![0])
      )
        count++;
      if (count > 1) group.push(count);
      at += count > 1 ? count + 1 : 1;
    }
    inserts.push(group);
  }
  const lives: Json[] = [];
  for (const id in record.lives) lives.push(ref(id), record.lives[id]!);
  const fields: Json[] = [
    record.lamport - firstClock(record.inserts),
    inserts,
    record.moves.map(([id, parent, pos, backParent, backPos, life = 0]) =>
      placed(
        [ref(id), ref(parent), write(pos)],
        pos,
        moveTail(id, parent, backParent, backPos, life, ref, write),
      ),
    ),
    record.deletes.map(([session, ...range]) => [
      sessions.index(session),
      ...range,
    ]),
    lives,
    record.pending.map(([lamport, seen, owner, ...range]) => [
      lamport,
      sessions.index(seen),
      sessions.index(owner),
      ...range,
    ]),
    sessions.index(record.session),
  ];
  return recordRow(fields);
}

/**
 * What a move writes after its position, `life, backParent, backPos`,
 * without the defaults at the end: life 0, the move's own parent as the back
 * parent (`""` when only the back place is not the default) and the node's
 * id as the back place. A move without a back (an affirmed cut) writes
 * `false` as its back parent.
 */
function moveTail(
  id: string,
  parent: string | 0,
  backParent: string | 0 | Nil,
  backPos: string | Nil,
  life: number,
  ref: (id: string | 0) => Json,
  write: (id: string) => Json,
): Json[] {
  if (backParent === null) return [life, false];
  const tail: Json[] = [
    life,
    backParent === parent ? "" : ref(backParent),
    backPos === id ? "" : write(backPos!),
  ];
  while (tail.at(-1) === "") tail.pop();
  return tail.length === 1 && life === 0 ? [] : tail;
}

/** Ascending runs of consecutive numbers. */
function runsOf(numbers: number[]): [number, number][] {
  const sorted = [...numbers].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const n of sorted) {
    const last = runs.at(-1);
    if (last?.[1] === n - 1) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}

/**
 * The clock of the first node a record inserts, which its Lamport clock is
 * written after: an author that only types keeps the two close.
 */
const firstClock = (inserts: InsertGroup[]) => {
  const first = inserts[0]?.[1];
  return first ? parseId(first[0])[1] : 0;
};

/** `[session, clock]`. An id that is not `session.clock` is its own session. */
function parseId(id: string): [string, number] {
  const dot = lastDot(id);
  const clock = dot > 0 ? clockAt(id, dot) : -1;
  return clock < 0 ? [id, 0] : [id.slice(0, dot), clock];
}

/** Where each part of the stored labels is (see `StoredLabels`). */
const LABELS_CLOCK = 0;
const LABELS_COLUMNS = 1;
const LABELS_DELETED = 2;
const LABELS_ROOT_STAMPS = 3;
const LABELS_PLACES = 4;
const LABELS_EXTRAS = 5;
const LABELS_LIMBO = 6;
const LABELS_ALIASES = 7;
const LABELS_PENDING = 8;
const LABELS_LISTS = 9;

/** A part of the stored labels that is left out at the end (see `LABELS_*`). */
const unwritten = (value: Json | undefined) =>
  value === 0 || value === "" || (Array.isArray(value) && value.length === 0);

const isEmpty = (value: Json | undefined) =>
  value === null || (Array.isArray(value) && value.length === 0);

type Pending = { life: number; seen: Stamp; own: boolean };

const ROOT_POS = "";

/** Steps up from a node before `#hasNewCycle` keeps the ids it walked. */
const CYCLE_STEPS = 32;

/** What a remote change runs instead of the normalize listeners: nothing. */
const NO_LISTENERS: Doc["_normalizeListeners"] = new Set();

/**
 * The change event of a batch the engine merged: it sends that batch on. A
 * merge is never undone, so its inverse is empty.
 */
const mergeEvent = (doc: Doc, operations: Operations): ChangeEvent => ({
  operations,
  inverseOperations: compactOperations(doc["_inverseOperations"]),
  diff: doc["_diff"],
  flags: doc["_transactionFlags"],
});

class Engine implements CrdtEngine {
  #entries = new Map<string, Entry>();
  #deleted = new IdRanges();
  #clock = 0;
  #session: string | undefined;
  /** Entries that wait for a parent that is missing, by the missing parent. */
  #waiting: Map<string, Set<Entry>> | undefined;
  /** The cycle cut: node id -> where it is shown instead of its pointer. */
  #cuts = new Map<string, Back>();
  readonly #doc: Doc;
  readonly #generator: Doc["_nodeIdGenerator"];
  readonly #options: Required<CrdtOptions>;
  /** The diff of the transaction that merged remote labels, if any. */
  #remoteDiff: Diff | undefined;
  #dirty = new Set<Entry>();
  /** Entries whose place may not fit their neighbours: placed again. */
  #forced: Set<Entry> | undefined;
  #dropped: Entry[] = [];
  #repairing: { lamport: number } | undefined;
  #normalizeClock = -1;
  #normalizeCount = 0;
  /** What `Doc` does without an engine, for what the engine passes on. */
  readonly #apply: Doc["applyOperations"];
  /** `newId`: old id -> id it got when its delete was undone. */
  #aliases: Map<string, string> | undefined;
  /** Descendants of deleted nodes: they die unless a move took them out. */
  #pending: Map<string, Pending> | undefined;
  /** Whether a stored node was loaded away from where it points, or hidden. */
  #offTree = false;
  /** Ids this replica must remove for good, with the clock they were queued. */
  #garbage: Map<string, number> | undefined;
  /** The places of every parent's children (FugueMax, see `./fugue.ts`). */
  #fugue: FugueSiblings;
  /** The session of the places this replica makes. */
  #ownPlaces: string | undefined;
  /** Entries waiting for a place to be shown there, by the place. */
  #placeWaiters: Map<string, Set<Entry>> | undefined;

  constructor(doc: Doc, options: CrdtOptions = {}) {
    this.#doc = doc;
    this.#options = {
      undo: options.undo ?? "lives",
      gcDelay: options.gcDelay ?? 100,
    };
    this.#fugue = this.#newFugue();
    this.#generator = doc["_nodeIdGenerator"];
    // The engine takes over what it changes of the document: it is created
    // before the extensions and the undo manager, so its change listener is
    // the first one, and it turns the event into what it sends.
    doc["_createNodeId"] = () => this.#normalizeId() ?? this.#generator(doc);
    this.#apply = doc.applyOperations.bind(doc);
    doc.applyOperations = (operations, flags) =>
      this.#applyOperations(operations, flags);
    const toJSON = doc.toJSON.bind(doc);
    doc.toJSON = (options) => this.#toJSON(toJSON(options));
    doc.onChange((event) => this.#commit(event));
  }

  /**
   * A node created by normalize gets an id every replica computes alike, so
   * two replicas repairing the same state end up with one node, not two.
   */
  #normalizeId() {
    const doc = this.#doc;
    const stage = doc["_lifeCycleStage"];
    if (!this.#repairing && stage !== "normalize" && stage !== "normalize2") {
      return undefined;
    }
    if (this.#normalizeClock !== this.#clock) {
      this.#normalizeClock = this.#clock;
      this.#normalizeCount = 0;
    }
    const id = `r${this.#clock}.${this.#normalizeCount}`;
    if (!doc["_idGen"].validate(id)) return undefined;
    this.#normalizeCount++;
    return id;
  }

  /* ----------------------------------- fugue ----------------------------------- */

  #newFugue() {
    return new FugueSiblings((id) => {
      const waiting = this.#placeWaiters?.get(id);
      if (!waiting) return;
      this.#placeWaiters!.delete(id);
      // Placed again, from the end to its place.
      for (const entry of waiting) this.#dirty.add(entry);
    });
  }

  /** If `place` is not in its list yet, `entry` is placed again when it is. */
  #waitForPlace(place: string, entry: Entry) {
    if (this.#fugue.has(place)) return;
    const waiters = (this.#placeWaiters ??= new Map<string, Set<Entry>>());
    let waiting = waiters.get(place);
    if (!waiting) waiters.set(place, (waiting = new Set()));
    waiting.add(entry);
  }

  /** A session only this replica uses, for the places it makes. */
  #placeSession() {
    return (this.#ownPlaces ??= parseId(this.#generator(this.#doc))[0]);
  }

  /** Whether a node shown at `key` under `parent` is away from it. */
  #isAway(key: string, parent: string) {
    return this.#fugue.listOf(key) !== parent;
  }

  /**
   * A new place for each node of a run that changed place, right
   * after the place of the node before it. A first life's place has the
   * node's id; `mint` names any other.
   */
  #placeRun(run: DocNode[], inserted: Set<string>, mint: () => string) {
    const first = run[0]!;
    const parent = first.parent!;
    // Nodes shown away from their place go last (see `#prevSibling`): the
    // run goes after the last placed one, and is sorted again.
    let before = first.prev;
    while (before && this.#entries.get(before.id)!.away) before = before.prev;
    let left = before ? this.#keyOf(before) : undefined;
    const list = parent.id;
    const ids = run.map((node) => {
      const entry = this.#entries.get(node.id);
      const fresh =
        inserted.has(node.id) && !entry && this.#deadLife(node.id) < 0;
      const id = fresh ? node.id : mint();
      this.#fugue.create(id, node.id, list, left);
      left = id;
      return id;
    });
    return { ids, resort: before !== first.prev };
  }

  /* ---------------------------------- session ---------------------------------- */

  /** A fresh local id tells the session without spending an id on it. */
  #sessionId(fresh: Set<string>) {
    if (this.#session === undefined) {
      const doc = this.#doc;
      const [first] = fresh;
      const id =
        first !== undefined && this.#deadLife(first) < 0
          ? first
          : this.#generator(doc);
      this.#session = parseId(id)[0];
    }
    return this.#session;
  }

  /* ----------------------------------- labels ----------------------------------- */

  #rootEntry() {
    const { root } = this.#doc;
    let entry = this.#entries.get(root.id);
    if (!entry) {
      entry = this.#newEntry(root.id, 0, root.type);
      entry.node = root;
      entry.at = [0, ""];
      entry.key = ROOT_POS;
      this.#entries.set(root.id, entry);
    }
    return entry;
  }

  #newEntry(id: string, life: number, type?: string): Entry {
    return {
      id,
      life,
      type,
      parent: undefined,
      pos: "",
      at: undefined,
      back: undefined,
      stamps: {},
      born: undefined,
      pending: undefined,
      node: undefined,
      key: "",
      alive: true,
      away: false,
    };
  }

  #deadLife(id: string) {
    if (this.#deleted.isEmpty()) return -1;
    const [session, clock] = parseId(id);
    return this.#deleted.get(session, clock);
  }

  #ensure(id: string, life: number): Entry | undefined {
    if (this.#deadLife(id) >= life) return undefined;
    let entry = this.#entries.get(id);
    if (entry) {
      if (entry.life > life) return undefined;
      if (entry.life === life) return entry;
      this.#kill(entry);
    }
    entry = this.#newEntry(id, life);
    this.#entries.set(id, entry);
    return entry;
  }

  /**
   * Forgets what was pending for this life of the node. A record for a later
   * life may have arrived before that life's insert, and stays.
   */
  #dropPending(entry: Entry) {
    if ((this.#pending?.get(entry.id)?.life ?? 0) <= entry.life)
      this.#pending?.delete(entry.id);
  }

  #kill(entry: Entry) {
    this.#entries.delete(entry.id);
    this.#dropPending(entry);
    this.#garbage?.delete(entry.id);
    this.#dropped.push(entry);
    for (const parent of this.#watchedParents(entry))
      this.#unwait(parent, entry);
    const waiters = this.#waiting?.get(entry.id);
    waiters?.forEach((waiter) => this.#dirty.add(waiter));
    if (entry.node) this.#dirtyChildren(entry.node);
  }

  /** A hidden node can still link children that were removed since. */
  #dirtyChildren(node: DocNode) {
    node.children().forEach((child) => {
      const childEntry = this.#entries.get(child.id);
      // Not one killed in the same batch (the fuzz reaches it).
      /* v8 ignore next -- @preserve */
      if (childEntry) this.#dirty.add(childEntry);
    });
  }

  #wait(parent: string, entry: Entry) {
    const waiting = (this.#waiting ??= new Map<string, Set<Entry>>());
    let waiters = waiting.get(parent);
    if (!waiters) waiting.set(parent, (waiters = new Set()));
    waiters.add(entry);
  }

  #unwait(parent: string, entry: Entry) {
    const waiters = this.#waiting?.get(parent);
    if (!waiters) return;
    waiters.delete(entry);
    if (waiters.size === 0) this.#waiting!.delete(parent);
  }

  /* ------------------------------- local commits ------------------------------- */

  /**
   * The first change listener: the engine turns the event into what it sends.
   * `operations` becomes the labels (or, for a remote batch, the batch as it
   * came, to pass on).
   */
  #commit(event: ChangeEvent) {
    const doc = this.#doc;
    this.#rootEntry();
    if (this.#remoteDiff === doc["_diff"]) {
      // The event sends on the batch that came (see `mergeEvent`).
      this.#remoteDiff = undefined;
      return;
    }
    const classic = doc["_operations"];
    const classicBatch = event.operations;
    const inverse = doc["_inverseOperations"];
    const opsLength = classic[0].length;
    const inverseLength = inverse[0].length;
    const diff = doc["_diff"];
    // A stored node is linked as it was: only new nodes are inserted.
    const fresh = diff.inserted;
    // Opt-in state kinds (text) keep their own ordered operations.
    const passThrough = classic[0].filter((op) => op[0] === 3);
    // Only nodes this transaction inserted or changed have a patch: a node
    // linked as it was stored is not a change.
    if (
      fresh.size === 0 &&
      diff.moved.size === 0 &&
      diff.deleted.size === 0 &&
      isObjectEmpty(classic[1])
    ) {
      // Nodes inserted and deleted again in this transaction leave nothing.
      if (passThrough.length < opsLength)
        event.operations = [classicBatch[0], ...textRows(classicBatch)];
      return;
    }
    const session = this.#repairing ? "" : this.#sessionId(fresh);
    const lamport = this.#repairing ? this.#repairing.lamport : ++this.#clock;
    const stamp: Stamp = [lamport, session];

    const moved = new Map<string, Back>();
    for (const id of diff.moved) {
      moved.set(id, this.#shownBack(this.#entries.get(id)!));
    }

    const inserts: InsertGroup[] = [];
    const moves: MoveRecord[] = [];
    const lives: Record<string, number> = {};
    this.#assignPositions(fresh, moved, stamp, inserts, moves, lives);

    const [deletes, pending] = this.#commitDeletes(diff.deleted);

    const states = classic[1];
    for (const id in states) {
      const entry = this.#entries.get(id)!;
      const stamps = entry.stamps;
      // The values an insert writes share its stamp (see `#birthStamp`).
      const at = fresh.has(id) ? entry.born! : stamp;
      for (const key in states[id]) stamps[key] = at;
      if (entry.life > 0) lives[id] = entry.life;
    }
    // What the core encoded, without the tree rows: the labels say it. A
    // head that names other sessions (as the tree rows needed) is encoded
    // again, before the reconcile below adds what every replica does.
    const textAndState =
      typeof classicBatch[0] === "string"
        ? classicBatch
        : encodeOperations(passThrough, states);
    this.#affirm(stamp, moves, moved);
    this.#forced?.forEach((entry) => this.#dirty.add(entry));
    if (
      this.#cuts.size > 0 ||
      this.#dirty.size > 0 ||
      this.#dropped.length > 0
    ) {
      // The local edit may dissolve or form a cut: same pure function as remote.
      doc["_lifeCycleStage"] = "update";
      this.#reconcile();
      doc["_lifeCycleStage"] = "change";
    }
    if (inverse[0].length !== inverseLength)
      event.inverseOperations = compactOperations(inverse);
    event.operations = this.#batch(
      { lamport, session, inserts, moves, deletes, lives, pending },
      textAndState,
    );
  }

  /** A batch with the labels of `record`, and the text and state of `classic`. */
  #batch(record: LabelRecord, classic: Operations = [""]): Operations {
    const sessions = new Sessions(classic[0]);
    return withEngineRow(
      sessions,
      encodeRecord(record, sessions, this.#fugue),
      textRows(classic),
    );
  }

  /** Where the author saw this node before moving it. */
  #shownBack(entry: Entry): Back {
    // A node the user could move was shown somewhere.
    return { parent: this.#target(entry)[0]!, pos: entry.key };
  }

  #affirm(stamp: Stamp, moves: MoveRecord[], moved: Map<string, Back>) {
    if (moved.size === 0 || this.#cuts.size === 0) return;
    const root = this.#doc.root.id;
    const wire = (id: string) => (id === root ? 0 : id);
    for (const [id, cut] of this.#cuts) {
      const entry = this.#entries.get(id);
      if (!entry || moved.has(id)) continue;
      const move: MoveBase = [id, wire(cut.parent), cut.pos, null, null];
      moves.push(entry.life > 0 ? [...move, entry.life] : move);
      entry.parent = cut.parent;
      entry.pos = cut.pos;
      entry.at = stamp;
      entry.back = undefined;
      this.#cuts.delete(id);
    }
  }

  #assignPositions(
    inserted: Set<string>,
    moved: Map<string, Back>,
    stamp: Stamp,
    inserts: InsertGroup[],
    moves: MoveRecord[],
    lives: Record<string, number>,
  ) {
    const doc = this.#doc;
    const root = doc.root;
    const wire = (id: string): string | 0 => (id === root.id ? 0 : id);
    const groups = new Map<DocNode, InsertGroup>();
    const done = new Set<string>();
    const dirty = (id: string) => inserted.has(id) || moved.has(id);
    const assign = (node: DocNode, pos: string) => {
      done.add(node.id);
      const parent = node.parent!;
      const wireParent = wire(parent.id);
      let entry = this.#entries.get(node.id);
      let at = stamp;
      if (inserted.has(node.id)) {
        // After its last dead life, and never before a life others already
        // gave it (a concurrent undo revived it while it was hidden here).
        const life = Math.max(this.#deadLife(node.id) + 1, entry?.life ?? 0);
        const insert: InsertRecord =
          life > 0
            ? [node.id, node.type, pos, life]
            : [node.id, node.type, pos];
        let group = groups.get(parent);
        if (!group) {
          group = [wireParent];
          groups.set(parent, group);
          inserts.push(group);
        }
        group.push(insert);
        // An undo can bring back a node that was hidden here: a new object.
        // Nodes hidden under the old one wait for its id and follow it.
        if (entry?.node) {
          this.#dirtyChildren(entry.node);
          this.#unlink(entry.node);
        }
        entry = this.#newEntry(node.id, life, node.type);
        at = entry.born = this.#birthStamp(node.id, life, pos, stamp);
        this.#entries.set(node.id, entry);
        if (life > 0) lives[node.id] = life;
      } else {
        entry = entry!;
        const back = moved.get(node.id)!;
        const move: MoveBase = [
          node.id,
          wireParent,
          pos,
          wire(back.parent),
          back.pos,
        ];
        moves.push(entry.life > 0 ? [...move, entry.life] : move);
        // Its old place (the node may have moved in this transaction).
        entry.back = back;
        this.#cuts.delete(node.id);
      }
      entry.node = node;
      entry.parent = parent.id;
      entry.pos = pos;
      entry.at = at;
      entry.key = pos;
      entry.away = false;
      this.#dirty.add(entry);
      this.#waiting?.get(node.id)?.forEach((waiter) => this.#dirty.add(waiter));
    };
    let minted = 0;
    // A repair makes the same places on every replica. Anything else is a
    // place of this replica, `session~.clock`: a session only it uses (not
    // that of its stamps, which may be another's: that of the first node it
    // inserts) and a clock of its own, the stamp's and then new ones.
    const mint = () =>
      this.#repairing
        ? `~${minted++ || ""}.${numberToBase64(stamp[0])}`
        : `${this.#placeSession()}~.${numberToBase64(minted++ === 0 ? stamp[0] : ++this.#clock)}`;
    const process = (start: DocNode) => {
      let first = start;
      while (first.prev && dirty(first.prev.id)) first = first.prev;
      const run: DocNode[] = [];
      for (let cur: DocNode | undefined = first; cur && dirty(cur.id); ) {
        run.push(cur);
        cur = cur.next;
      }
      const { ids, resort } = this.#placeRun(run, inserted, mint);
      run.forEach((node, i) => assign(node, ids[i]!));
      if (resort)
        for (const node of run)
          (this.#forced ??= new Set<Entry>()).add(this.#entries.get(node.id)!);
    };
    for (const id of [...inserted, ...moved.keys()]) {
      if (done.has(id)) continue;
      const node = doc.getNodeById(id);
      if (node) process(node);
    }
  }

  #keyOf(node: DocNode) {
    return this.#entries.get(node.id)!.key;
  }

  /**
   * A deleted node dies for good. Its descendants stay pending: they die unless
   * a concurrent move takes them out of the subtree first.
   */
  #commitDeletes(
    deleted: Map<string, DocNode>,
  ): [DeleteRecord[], PendingRecord[]] {
    const dead: [string, number][] = [];
    const pending = new Map<string, [Stamp, string, number, number[]]>();
    for (const [id, node] of deleted) {
      const entry = this.#entries.get(id)!;
      if (node.parent && deleted.has(node.parent.id)) {
        const seen = entry.at!;
        // A remote delete of an ancestor may have seen a later pointer: the
        // latest one decides, whatever the order they arrive in.
        const known = this.#pending?.get(id);
        const latest =
          known?.life === entry.life && compare(known.seen, seen) > 0
            ? known.seen
            : seen;
        // A later life's pending stays, as `#mergePending` keeps it when this
        // record comes back.
        if (!known || known.life <= entry.life)
          (this.#pending ??= new Map<string, Pending>()).set(id, {
            life: entry.life,
            seen: latest,
            own: true,
          });
        (this.#garbage ??= new Map<string, number>()).set(id, this.#clock);
        // Placed again so it waits for its parent: an undo may bring it back.
        this.#dirty.add(entry);
        const [owner, clock] = parseId(id);
        const key = `${seen[0]} ${seen[1]} ${owner} ${entry.life}`;
        const group = pending.get(key) ?? [seen, owner, entry.life, []];
        group[3].push(clock);
        pending.set(key, group);
        continue;
      }
      dead.push([id, entry.life]);
      this.#forget(entry);
    }
    this.#collectGarbage(dead);
    const records: PendingRecord[] = [];
    for (const [seen, owner, life, clocks] of pending.values()) {
      for (const [from, to] of runsOf(clocks)) {
        records.push([seen[0], seen[1], owner, from, to, life]);
      }
    }
    return [this.#deadRanges(dead), records];
  }

  /** Removes an entry this replica deleted itself. */
  #forget(entry: Entry) {
    this.#entries.delete(entry.id);
    this.#dropPending(entry);
    this.#garbage?.delete(entry.id);
    for (const parent of this.#watchedParents(entry)) {
      this.#unwait(parent, entry);
    }
  }

  /**
   * Removes for good what this replica queued long enough ago: descendants its
   * deletes left pending and its own inserts under a deleted parent. A delete
   * is the same for every replica in any order, so this is safe in P2P; what
   * it costs is that a move or an undo arriving later cannot rescue them.
   */
  #collectGarbage(dead: [string, number][]) {
    for (const [id, queued] of this.#garbage ?? []) {
      if (this.#clock - queued < this.#options.gcDelay) continue;
      const entry = this.#entries.get(id);
      this.#garbage!.delete(id);
      if (!entry || this.#isPlaced(entry)) continue;
      // Hidden only while its parent has not arrived: not garbage.
      // A hidden own node whose parent is alive.
      /* v8 ignore next -- @preserve */
      if (!this.#isDoomed(entry) && !this.#parentGone(entry)) continue;
      dead.push([id, entry.life]);
      this.#kill(entry);
    }
  }

  #parentGone(entry: Entry) {
    const parent = entry.parent!;
    const parentEntry = this.#entries.get(parent);
    return parentEntry
      ? this.#isDoomed(parentEntry)
      : this.#deadLife(parent) >= 0;
  }

  #isPlaced(entry: Entry) {
    const node = entry.node;
    return node !== undefined && this.#doc["_nodeMap"].get(node.id) === node;
  }

  #deadRanges(dead: [string, number][]): DeleteRecord[] {
    const bySession = new Map<string, Map<number, number[]>>();
    for (const [id, life] of dead) {
      const [session, clock] = parseId(id);
      const byLife = bySession.get(session) ?? new Map<number, number[]>();
      bySession.set(session, byLife);
      const clocks = byLife.get(life);
      if (clocks) clocks.push(clock);
      else byLife.set(life, [clock]);
    }
    const records: DeleteRecord[] = [];
    for (const [session, byLife] of bySession) {
      for (const [life, clocks] of byLife) {
        for (const [from, to] of runsOf(clocks)) {
          records.push([session, from, to, life]);
          this.#deleted.add(session, from, to, life);
        }
      }
    }
    return records;
  }

  /* --------------------------------- remote merge -------------------------------- */

  /** `doc.applyOperations`: labels merge, anything else is a local edit. */
  #applyOperations(operations: Operations, flags?: TransactionFlags) {
    const record = engineRow(operations, RECORD);
    const snapshot = engineRow(operations, SNAPSHOT);
    if (!record && !snapshot) {
      // An undo, which may name nodes that changed since.
      return applyLocal(this.#apply, operations, flags, (draft) =>
        this.#prepareClassic(draft),
      );
    }
    const doc = this.#doc;
    if (doc["_lifeCycleStage"] === "update") doc.forceCommit();
    const sessions = new Sessions(operations[0]);
    const [text, states] = decodeOperations(withoutEngineRow(operations));
    // Never undoable: only what this replica did is.
    doc["_transactionFlags"] = { ...flags, skipUndo: true };
    withTransaction(
      doc,
      () => {
        this.#rootEntry();
        this.#remoteDiff = doc["_diff"];
        if (record) {
          const places: Place[] = [];
          const labels = decodeRecord(record, sessions, places, doc.root.id);
          for (const place of places) this.#fugue.add(place);
          this.#mergeRecord(labels, states);
        } else this.#mergeSnapshot(snapshot![1]);
        this.#reconcile();
        if (text.length > 0) onApplyOperations(doc, [text, {}]);
        // A merge is never undone: no inverse to encode for it.
        doc["_inverseOperations"] = [[], {}];
        doc["_event"] = mergeEvent(doc, operations);
      },
      true,
    );
    // Normalize listeners do not run on a remote change: replicas would
    // repair it each its own way. The repair after it is a local change.
    const listeners = doc["_normalizeListeners"];
    if (doc["_lifeCycleStage"] === "update") {
      doc["_normalizeListeners"] = NO_LISTENERS;
      try {
        doc.forceCommit();
      } finally {
        doc["_normalizeListeners"] = listeners;
      }
    }
    this.#remoteDiff = undefined;
    doc["_event"] = undefined;
    if (
      listeners.size > 0 &&
      doc["_lifeCycleStage"] === "idle" &&
      !doc["_isForceCommitCallback"]
    )
      this.#repair();
  }

  #mergeRecord(record: LabelRecord, states: StatePatch) {
    const { lamport, session, inserts, moves, deletes, lives, pending } =
      record;
    this.#clock = Math.max(this.#clock, lamport);
    const stamp: Stamp = [lamport, session];
    deletes.forEach((del) => this.#mergeDelete(del));
    pending.forEach(([seenLamport, seenSession, owner, from, to, life]) => {
      for (let clock = from; clock <= to; clock++) {
        this.#mergePending(this.#idOf(owner, clock), life, [
          seenLamport,
          seenSession,
        ]);
      }
    });
    // Inserts without a stamp, and the values written with them.
    const unstamped = new Set<string>();
    inserts.forEach(([parent, ...nodes]) => {
      for (const insert of nodes) {
        const [id, type, pos] = insert;
        const life = insert.length > 3 ? insert[3]! : 0;
        const entry = this.#ensure(id, life);
        if (!entry) continue;
        const wasTyped = entry.type !== undefined;
        entry.type = type;
        const born = this.#birthStamp(id, life, pos, stamp);
        if (born === ZERO) unstamped.add(id);
        this.#mergePointer(entry, this.#parentId(parent), pos, born, undefined);
        if (!wasTyped) this.#onTyped(entry);
        this.#mergeBirth(entry, born);
      }
    });
    moves.forEach((move) => {
      const [id, parent, pos, backParent, backPos, life = 0] = move;
      const entry = this.#ensure(id, life);
      if (!entry) return;
      const back =
        backParent === null || backPos === null
          ? undefined
          : { parent: this.#parentId(backParent), pos: backPos };
      this.#mergePointer(entry, this.#parentId(parent), pos, stamp, back);
    });
    for (const id in states) {
      const entry = this.#ensure(id, lives[id] ?? 0);
      if (!entry) continue;
      const values = states[id]!;
      const at = unstamped.has(id) ? ZERO : stamp;
      for (const key in values) this.#mergeState(entry, key, values[key]!, at);
    }
  }

  /**
   * The first life of a node at its own place has no stamp (it is
   * `ZERO`). Anything that names the node (a move, a write, a cycle it is in)
   * comes from a replica that saw the insert, so it has a newer stamp anyway,
   * and the stored labels of nodes never moved need no stamp columns.
   */
  #birthStamp(id: string, life: number, pos: string, stamp: Stamp) {
    return life === 0 && pos === id ? ZERO : stamp;
  }

  #parentId(wire: string | 0) {
    return wire === 0 ? this.#doc.root.id : wire;
  }

  #mergeDelete([session, from, to, life]: DeleteRecord) {
    this.#deleted.add(session, from, to, life);
    for (let clock = from; clock <= to; clock++) {
      for (const id of this.#idsOf(session, clock)) {
        const entry = this.#entries.get(id);
        if (entry && entry.life <= life) this.#kill(entry);
      }
    }
  }

  /** A whole-id session names the id itself, with no clock suffix. */
  #idsOf(session: string, clock: number) {
    const id = this.#idOf(session, clock);
    return clock === 0 ? [id, session] : [id];
  }

  #idOf(session: string, clock: number) {
    return `${session}.${numberToBase64(clock)}`;
  }

  #mergePending(id: string, life: number, seen: Stamp) {
    const whole = id.slice(0, -2);
    const wholeId = id.endsWith(".-") && this.#entries.has(whole);
    for (const candidate of wholeId ? [id, whole] : [id]) {
      if (this.#deadLife(candidate) >= life) continue;
      // A later life of the node replaced this one: its record, applied
      // again, is old news.
      if ((this.#entries.get(candidate)?.life ?? life) > life) continue;
      const current = this.#pending?.get(candidate);
      if (
        current &&
        (current.life > life ||
          (current.life === life && compare(current.seen, seen) >= 0))
      ) {
        continue;
      }
      (this.#pending ??= new Map<string, Pending>()).set(candidate, {
        life,
        seen,
        own: current?.own ?? false,
      });
      const entry = this.#entries.get(candidate);
      if (entry) this.#dirty.add(entry);
    }
  }

  #onTyped(entry: Entry) {
    const doc = this.#doc;
    const node = doc["_nodeFromTree"]([entry.id, entry.type!, {}]);
    entry.node = node;
    for (const key in entry.pending) {
      this.#writeState(entry, key, entry.pending[key]!);
    }
    entry.pending = undefined;
    this.#waiting?.get(entry.id)?.forEach((waiter) => this.#dirty.add(waiter));
    this.#dirty.add(entry);
  }

  #mergePointer(
    entry: Entry,
    parent: string,
    pos: string,
    stamp: Stamp,
    back: Back | undefined,
  ) {
    if (entry.at && compare(stamp, entry.at) <= 0) return;
    if (entry.parent !== undefined) this.#unwait(entry.parent, entry);
    entry.parent = parent;
    entry.pos = pos;
    entry.at = stamp;
    entry.back = back;
    this.#dirty.add(entry);
  }

  /** An insert sets every key: older writes go back to the default. */
  #mergeBirth(entry: Entry, stamp: Stamp) {
    if (entry.born && compare(stamp, entry.born) <= 0) return;
    entry.born = stamp;
    const defaults = this.#doc["_resolvedNodeDefs"].get(entry.type!)!;
    for (const key in entry.stamps) {
      if (compare(entry.stamps[key]!, stamp) >= 0) continue;
      delete entry.stamps[key];
      this.#writeState(entry, key, defaults.defaultStrings[key]!);
    }
  }

  #mergeState(entry: Entry, key: string, value: string, stamp: Stamp) {
    const current = entry.stamps[key];
    if (current && compare(stamp, current) <= 0) return;
    // The insert's own values share its stamp.
    // A key the newer insert left at its default.
    /* v8 ignore next -- @preserve */
    if (entry.born && compare(stamp, entry.born) < 0) return;
    entry.stamps[key] = stamp;
    if (entry.node) this.#writeState(entry, key, value);
    else (entry.pending ??= {})[key] = value;
  }

  #writeState(entry: Entry, key: string, value: string) {
    const node = entry.node!;
    const doc = this.#doc;
    const diff = doc["_diff"];
    const attached = doc["_nodeMap"].get(node.id) === node;
    if (attached && !diff.inserted.has(node.id)) {
      diff.updated.add(node.id);
      (doc["_inverseOperations"][1][node.id] ??= {})[key] ??= stringifyStateKey(
        node,
        key,
      );
    }
    const state: Record<string, unknown> = node["_state"];
    state[key] = parseStateKey(node, key, value);
    if (attached) (doc["_operations"][1][node.id] ??= {})[key] = value;
  }

  /* ---------------------------------- the view ---------------------------------- */

  #isAlive(id: string) {
    if (id === this.#doc.root.id) return true;
    const entry = this.#entries.get(id);
    return entry?.type !== undefined && !this.#isDoomed(entry);
  }

  /**
   * A pending descendant dies while its pointer is still the one its deleter
   * saw and its parent is dead or doomed too: still under the deleted node.
   */
  #isDoomed(entry: Entry): boolean {
    if (!this.#pending?.size) return false;
    // Concurrent moves can leave pending pointers in a cycle. Its nodes were
    // all under the deleted node when its deleter saw them: doomed. Most
    // walks end at the first node, which needs no set.
    let visited: Set<Entry> | undefined;
    for (let current = entry; ; ) {
      const pending = this.#pending.get(current.id);
      if (pending?.life !== current.life || !current.at) return false;
      if (compare(current.at, pending.seen) > 0) return false;
      const parent = current.parent!;
      const parentEntry = this.#entries.get(parent);
      // Gone, or never arrived (the root always has its entry).
      if (parentEntry?.type === undefined) return parent !== this.#doc.root.id;
      (visited ??= new Set()).add(current);
      if (visited.has(parentEntry)) return true;
      current = parentEntry;
    }
  }

  /** Where the pointer of an entry takes it, before looking at cycles. */
  #pointerTarget(entry: Entry): string | undefined {
    if (entry.parent === undefined) return undefined;
    if (this.#isAlive(entry.parent)) return entry.parent;
    if (entry.back && this.#isAlive(entry.back.parent))
      return entry.back.parent;
    return undefined;
  }

  #target(entry: Entry): [string | undefined, string] {
    if (this.#isDoomed(entry)) return [undefined, entry.pos];
    const cut = this.#cuts.get(entry.id);
    if (cut) return [cut.parent, cut.pos];
    const parent = this.#pointerTarget(entry);
    if (parent === undefined) return [undefined, entry.pos];
    if (parent === entry.parent) return [parent, entry.pos];
    return [parent, entry.back!.pos];
  }

  /** True if some cycle exists, found by walking up from the changed entries. */
  #hasNewCycle() {
    const rootId = this.#doc.root.id;
    for (const entry of this.#dirty) {
      // Most walks reach the root in a few steps: the set that finds a
      // cycle is made only for a long one.
      let seen: Set<string> | undefined;
      for (let cur = entry.id, steps = 0; ; steps++) {
        if (steps > CYCLE_STEPS) {
          seen ??= new Set();
          if (seen.has(cur)) return true;
          seen.add(cur);
        }
        const at = this.#entries.get(cur);
        const parent = at && this.#pointerTarget(at);
        if (parent === undefined || parent === rootId) break;
        cur = parent;
      }
    }
    return false;
  }

  /** The cycle cut: a pure function of the labels. */
  #resolveCuts() {
    const rootId = this.#doc.root.id;
    const cuts = new Map<string, Back>();
    const stages = new Map<string, number>();
    const edge = new Map<string, string | undefined>();
    for (const entry of this.#entries.values()) {
      if (entry.id !== rootId && entry.type !== undefined && entry.at) {
        edge.set(entry.id, this.#pointerTarget(entry));
      }
    }
    const worst = (cycle: string[]) => {
      let best = cycle[0]!;
      for (const id of cycle) {
        const a = this.#entries.get(id)!.at!;
        const b = this.#entries.get(best)!.at!;
        if (compare(a, b) > 0) best = id;
      }
      return best;
    };
    for (;;) {
      const color = new Map<string, string>();
      const cycles: string[][] = [];
      for (const start of edge.keys()) {
        if (color.has(start)) continue;
        const path: string[] = [];
        let cur: string | undefined = start;
        while (cur !== undefined && edge.has(cur) && !color.has(cur)) {
          color.set(cur, start);
          path.push(cur);
          cur = edge.get(cur);
        }
        if (cur !== undefined && color.get(cur) === start && edge.has(cur)) {
          cycles.push(path.slice(path.indexOf(cur)));
        }
      }
      if (cycles.length === 0) break;
      for (const cycle of cycles) {
        const id = worst(cycle);
        const entry = this.#entries.get(id)!;
        const stage = stages.get(id) ?? 0;
        let next = rootId;
        // A second cut of the same node, when its previous position closes
        // another cycle. The lab fuzz reaches it.
        /* v8 ignore next 9 -- @preserve */
        if (
          stage === 0 &&
          entry.back &&
          this.#isAlive(entry.back.parent) &&
          entry.back.parent !== id
        ) {
          next = entry.back.parent;
          stages.set(id, 1);
        } else {
          stages.set(id, 2);
        }
        edge.set(id, next);
        // A cut node is always one that moved.
        /* v8 ignore next -- @preserve */
        cuts.set(id, { parent: next, pos: entry.back?.pos ?? entry.pos });
      }
    }
    return cuts;
  }

  #reconcile() {
    const rootId = this.#doc.root.id;
    this.#updateCuts();
    // Real removals first, so that a removed parent never receives children.
    for (const entry of this.#dropped) this.#remove(entry);
    this.#dropped = [];

    // Placing an entry can change whether others are visible, and so where
    // their pointers lead, which can close or open a cycle: repeat.
    while (this.#dirty.size > 0) {
      const order = this.#topDown([...this.#dirty], rootId);
      this.#dirty.clear();
      for (const entry of order) {
        if (this.#entries.get(entry.id) !== entry) continue;
        this.#place(entry);
      }
      if (this.#dirty.size > 0) this.#updateCuts();
    }
  }

  #updateCuts() {
    if (this.#cuts.size === 0 && !this.#hasNewCycle()) return;
    const previous = this.#cuts;
    this.#cuts = this.#resolveCuts();
    for (const id of new Set([...previous.keys(), ...this.#cuts.keys()])) {
      const entry = this.#entries.get(id);
      if (entry) this.#dirty.add(entry);
    }
  }

  #remove(entry: Entry) {
    const node = entry.node;
    if (!node) return;
    const doc = this.#doc;
    const attached = doc["_nodeMap"].get(node.id) === node;
    // `#unlink` does nothing for a hidden node that is not linked anywhere.
    if (attached) this.#classicDelete(node);
    else this.#unlink(node);
    entry.node = undefined;
  }

  /** Classic delete leaves stale prev/next/parent pointers on the node. */
  #classicDelete(node: DocNode) {
    node.to(node).delete();
    this.#clearLinks(node);
  }

  #clearLinks(node: DocNode) {
    node["_set"]("parent", undefined);
    node["_set"]("prev", undefined);
    node["_set"]("next", undefined);
  }

  #unlink(node: DocNode) {
    if (node.parent) detachRange(node, node);
    this.#clearLinks(node);
  }

  #topDown(entries: Entry[], rootId: string) {
    if (entries.length === 1) return entries;
    const depth = new Map<Entry, number>();
    const depthOf = (entry: Entry): number => {
      const known = depth.get(entry);
      if (known !== undefined) return known;
      depth.set(entry, 0);
      const [parent] = this.#target(entry);
      const parentEntry =
        parent !== undefined && parent !== rootId
          ? this.#entries.get(parent)
          : undefined;
      const value = parentEntry ? 1 + depthOf(parentEntry) : 0;
      depth.set(entry, value);
      return value;
    };
    return entries
      .map((entry) => [depthOf(entry), entry] as const)
      .sort((a, b) => a[0] - b[0])
      .map(([, entry]) => entry);
  }

  #place(entry: Entry) {
    const node = entry.node;
    if (!node) return;
    const alive = this.#isAlive(entry.id);
    if (alive !== entry.alive) {
      entry.alive = alive;
      this.#wake(entry);
    }
    const doc = this.#doc;
    const map = doc["_nodeMap"];
    const [parentId, key] = this.#target(entry);
    // A place that has not arrived yet places the node again when it does. Meanwhile it goes after the placed ones (see `#prevSibling`).
    if (parentId !== undefined) this.#waitForPlace(key, entry);
    const away = parentId !== undefined && this.#isAway(key, parentId);
    const parentEntry =
      parentId === undefined ? undefined : this.#entries.get(parentId);
    const parent =
      parentId === undefined
        ? undefined
        : parentId === doc.root.id
          ? doc.root
          : parentEntry?.node;
    const unchanged =
      map.get(node.id) === node &&
      parent !== undefined &&
      node.parent === parent &&
      key === entry.key &&
      away === entry.away &&
      map.get(parent.id) === parent;
    if (unchanged && !this.#forced?.delete(entry)) {
      this.#refreshWaiting(entry);
      return;
    }
    entry.key = key;
    entry.away = away;
    this.#refreshWaiting(entry);
    const attachedNow = map.get(node.id) === node;
    const parentAttached =
      parent !== undefined && map.get(parent.id) === parent;

    if (parent === undefined) {
      // Limbo: invisible, but its labels stay until garbage collection.
      if (attachedNow) this.#classicDelete(node);
      else if (node.parent) this.#unlink(node);
      if (
        this.#session === parseId(entry.id)[0] &&
        !this.#garbage?.has(entry.id)
      ) {
        (this.#garbage ??= new Map<string, number>()).set(
          entry.id,
          this.#clock,
        );
      }
      return;
    }
    if (attachedNow && parentAttached) {
      // Its new parent is still shown inside it, until the nodes between
      // them are placed: those go first, then this one again.
      if (this.#defer(entry, node, parent)) return;
      const prev = this.#prevSibling(parent, entry);
      if (prev) node.to(node).move(prev, "after");
      else node.to(node).move(parent, "prepend");
      return;
    }
    if (attachedNow && !parentAttached) this.#classicDelete(node);
    else if (node.parent) this.#unlink(node);
    // Under a hidden parent too: nothing outside the document is recorded.
    const prev = this.#prevSibling(parent, entry);
    if (prev) doc["_insertRange"](prev, "after", [node]);
    else doc["_insertRange"](parent, "prepend", [node]);
  }

  #defer(entry: Entry, node: DocNode, parent: DocNode) {
    const between: Entry[] = [];
    for (let up: DocNode | undefined = parent; up; up = up.parent) {
      if (up === node) {
        for (const each of between) this.#dirty.add(each);
        this.#dirty.add(entry);
        return true;
      }
      between.push(this.#entries.get(up.id)!);
    }
    return false;
  }

  /**
   * Entries that point at this one may now be shown, or hidden. Its children
   * too: a child moved into a node that is now doomed falls back elsewhere.
   */
  #wake(entry: Entry) {
    this.#waiting?.get(entry.id)?.forEach((waiter) => this.#dirty.add(waiter));
    this.#dirtyChildren(entry.node!);
  }

  #watchedParents(entry: Entry) {
    const parents = new Set<string>();
    if (entry.parent !== undefined) parents.add(entry.parent);
    if (entry.back) parents.add(entry.back.parent);
    return parents;
  }

  /** An entry shown away from a missing parent must hear when it arrives. */
  #refreshWaiting(entry: Entry) {
    // Most entries watch only their parent.
    if (!entry.back && entry.parent !== undefined) {
      this.#rewait(entry.parent, entry);
      return;
    }
    for (const parent of this.#watchedParents(entry))
      this.#rewait(parent, entry);
  }

  #rewait(parent: string, entry: Entry) {
    this.#unwait(parent, entry);
    if (!this.#isAlive(parent)) this.#wait(parent, entry);
  }

  #prevSibling(parent: DocNode, entry: Entry): DocNode | undefined {
    // A node placed again later, still away, is not one to go after.
    if (!entry.away)
      return this.#fugue.findBefore(entry.key, (owner, place) => {
        const other = this.#entries.get(owner);
        return other?.key === place &&
          other.node?.parent === parent &&
          !other.away
          ? other.node
          : undefined;
      });
    // Shown away from its place (a cycle cut to the root, or a place that
    // has not arrived): after the nodes placed in this parent, by id.
    for (let prev = parent.last; prev; prev = prev.prev) {
      if (prev === entry.node) continue;
      const other = this.#entries.get(prev.id)!;
      if (!other.away || prev.id < entry.id) return prev;
    }
    return undefined;
  }

  /* ----------------------------------- repair ---------------------------------- */

  /**
   * Normalize listeners never run on a remote change. If it left something
   * they would repair, they repair it now, as a local change of its own.
   */
  #repair() {
    const doc = this.#doc;
    const listeners = doc["_normalizeListeners"];
    this.#repairing = { lamport: this.#clock };
    try {
      doc.forceCommit(
        () => {
          listeners.forEach((listener) => listener({ diff: doc["_diff"] }));
        },
        { skipUndo: true },
      );
    } finally {
      this.#repairing = undefined;
    }
  }

  /* --------------------------- undo and aborts (classic) --------------------------- */

  // Only an undo of a range move whose target ended inside the range, which
  // the lab fuzz reaches.
  /* v8 ignore next 8 -- @preserve */
  #isInside(target: DocNode, start: DocNode, end: DocNode) {
    for (let cur: DocNode | undefined = start; cur; cur = cur.next) {
      if (target === cur) return true;
      if (target.ancestors().find((a) => a === cur)) return true;
      if (cur === end) break;
    }
    return false;
  }

  #resolveAlias(id: string) {
    let current = id;
    let alias = this.#aliases?.get(current);
    while (alias !== undefined) {
      current = alias;
      alias = this.#aliases!.get(current);
    }
    return current;
  }

  /** Makes an inverse apply reliable when anchors or ids changed meanwhile. */
  #prepareClassic(operations: DraftOperations): DraftOperations {
    const doc = this.#doc;
    const { root } = doc;
    const newId = this.#options.undo === "newId";
    const fresh = new Map<string, string>();
    const name = (id: string) => {
      const known = fresh.get(id) ?? this.#resolveAlias(id);
      return known;
    };
    const mapId = (id: string | 0) => (id === 0 ? 0 : name(id));
    const [ordered, patch] = operations;
    const out: OrderedOperation[] = ordered.flatMap(
      (op): OrderedOperation[] => {
        if (op[0] === 0) {
          const nodes = op[1].flatMap(([id, type]): [string, string][] => {
            if (
              newId &&
              this.#deadLife(name(id)) >= 0 &&
              !doc.getNodeById(name(id))
            ) {
              const replacement = doc["_nodeIdGenerator"](doc);
              fresh.set(id, replacement);
              (this.#aliases ??= new Map<string, string>()).set(
                this.#resolveAlias(id),
                replacement,
              );
              return [[replacement, type]];
            }
            return [[name(id), type]];
          });
          return [[0, nodes, mapId(op[2]), mapId(op[3]), mapId(op[4])]];
        }
        if (op[0] === 1) return [[1, name(op[1]), mapId(op[2])]];
        if (op[0] === 2) {
          const live = (id: string | 0) =>
            id === 0 ? undefined : doc.getNodeById(name(id));
          const prev = live(op[4]);
          const next = prev ? undefined : live(op[5]);
          const parent = op[3] === 0 ? root : doc.getNodeById(name(op[3]));
          const start = doc.getNodeById(name(op[1]));
          const target = prev ?? next ?? parent;
          // The inverse of a move can no longer apply: the node stays where it is.
          if (!start || !target) return [];
          const end = live(op[2]) ?? start;
          // See `#isInside`.
          /* v8 ignore next -- @preserve */
          if (this.#isInside(target, start, end)) return [];
          // Range undo, and a parent that died while an anchor moved away:
          // both are rare enough that only the lab fuzz reaches them.
          /* v8 ignore next -- @preserve */
          const endId = end === start ? 0 : end.id;
          /* v8 ignore next -- @preserve */
          const parentId = parent?.id ?? 0;
          return [
            [2, name(op[1]), endId, parentId, prev?.id ?? 0, next?.id ?? 0],
          ];
        }
        return [op];
      },
    );
    const states: StatePatch = {};
    for (const id in patch) states[name(id)] = patch[id]!;
    return [out, states];
  }

  /* --------------------------------- snapshot ---------------------------------- */

  /**
   * `doc.toJSON`: the labels go after the tree and the text, and their
   * sessions in the document's table, after those (see `StoredLabels`).
   */
  #toJSON(json: JsonDoc): JsonDoc {
    this.#rootEntry();
    const rootId = this.#doc.root.id;
    const sessions = new SessionTable();
    for (const session of storedSessions(json, rootId)) sessions.index(session);
    const names = sessionWriter(sessions);
    const sessionColumn = new ColumnWriter();
    const lamportColumn = new ColumnWriter();
    const placeColumn = new ColumnWriter();
    const places: string[] = [];
    const extras: Json[] = [];
    let index = 0;
    let lamport = 0;
    const walk = (parent: DocNode) => {
      for (let child = parent.first; child; child = child.next) {
        const entry = this.#entries.get(child.id)!;
        const [clock, session] = entry.at!;
        sessionColumn.push(names.index(session));
        lamportColumn.pushSigned(clock - lamport);
        lamport = clock;
        // A place with the node's id is not written.
        placeColumn.push(placeKind(entry, child.id, places));
        const extra = this.#extra(entry, names, false);
        if (extra) extras.push(index, extra);
        index++;
        walk(child);
      }
    };
    walk(this.#doc.root);
    const hidden: Entry[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.id === rootId) continue;
      const node = entry.node;
      // Shown: linked under a node of the document.
      if (node && this.#doc["_nodeMap"].get(node.id) === node) continue;
      hidden.push(entry);
    }
    hidden.sort((a, b) => Number(a.id > b.id) - Number(a.id < b.id));
    const limbo = hidden.map((entry): Json[] => {
      const [clock, session] = entry.at ?? ZERO;
      // A hidden label always says where its pointer is.
      const extra = this.#extra(entry, names, true)!;
      const label: Json[] = [entry.pos, clock, names.index(session), extra];
      const state = entry.node ? entry.node["_stateToJson"]() : entry.pending;
      return [names.write(entry.id), entry.type ?? 0, label, state ?? 0];
    });
    const aliases: Json[] = [];
    for (const [old, renamed] of this.#aliases ?? [])
      aliases.push(names.write(old), names.write(renamed));
    const rootStamps: Json[] = [];
    const root = this.#entries.get(rootId)!;
    for (const key in root.stamps) {
      const [clock, session] = root.stamps[key]!;
      rootStamps.push(key, clock, names.index(session));
    }
    const pending: Json[] = [];
    for (const [id, { life, seen, own }] of [...(this.#pending ?? [])].sort(
      (a, b) => Number(a[0] > b[0]) - Number(a[0] < b[0]),
    ))
      pending.push(names.write(id), life, seen[0], names.index(seen[1]), +own);
    const deleted: Json[] = [];
    this.#deleted.forEach((session, runs) =>
      deleted.push([names.index(session), ...runs]),
    );
    // In the order of `LABELS_*`, without the empty ones at the end.
    const stored: Json[] = [
      this.#clock,
      joinColumns([sessionColumn, lamportColumn, placeColumn]),
      deleted,
      rootStamps,
      places,
      extras,
      limbo,
      aliases,
      pending,
      this.#fugue.toJSON(
        (list) => childIds(this.#doc, list),
        (owner, place) => this.#entries.get(owner)?.key === place,
        sessions,
      ),
    ];
    while (stored.length > 1 && unwritten(stored.at(-1))) stored.pop();
    // Labels of no node, with clock 0, are those of a document stored
    // without them (see `load`): they are left out.
    if (stored.length === 1 && stored[0] === 0) return json;
    // The document's table again, with the labels' sessions after its own,
    // and its first column, how much each shares with the one before.
    const columns = splitColumns(columnsOf(json)).map((column) => ({
      encode: () => column,
    }));
    if (json[0].length > 1) columns.shift();
    const shared = new ColumnWriter();
    const table = frontCode(sessions.table, rootId, shared);
    // Every element before the labels is written, `0` when empty.
    const [state, text = 0, , typeNames = 0, values = 0] = elementsOf(json);
    return storedDoc(table, json[1], [
      state,
      text,
      joinColumns([...sharedColumn(table, shared), ...columns]) || 0,
      typeNames,
      values,
      stored,
    ]);
  }

  /** What a label has that its columns leave out, or nothing. */
  #extra(
    entry: Entry,
    names: ReturnType<typeof sessionWriter>,
    hidden: boolean,
  ) {
    const at = entry.at ?? ZERO;
    const extra: Record<string, Json> = {};
    if (entry.life > 0) extra.l = entry.life;
    if (entry.born && compare(entry.born, at) !== 0)
      extra.o = [entry.born[0], names.index(entry.born[1])];
    if (entry.back) {
      extra.b = names.write(entry.back.parent);
      extra.p = entry.back.pos;
    }
    const shownAtPointer =
      entry.node?.parent?.id === entry.parent && entry.key === entry.pos;
    if (hidden || !shownAtPointer) {
      extra.u = entry.parent === undefined ? 0 : names.write(entry.parent);
      extra.q = entry.pos;
    }
    // The stamp of a value written with the label's own is left out.
    const written = entry.node?.["_stateToJson"]() ?? {};
    const stamps: Json[] = [];
    for (const key in entry.stamps) {
      const stamp = entry.stamps[key]!;
      if (key in written && compare(stamp, at) === 0) continue;
      stamps.push(key, stamp[0], names.index(stamp[1]));
    }
    if (stamps.length > 0) extra.s = stamps;
    return isObjectEmpty(extra) ? undefined : extra;
  }

  /** Sets what `label` stores on `entry` (see `#extra`). */
  #restoreLabel(
    entry: Entry,
    label: Label,
    names: StoredLabels,
    state: object,
  ) {
    const { pos, at } = label;
    entry.pos = pos;
    entry.key = pos;
    entry.at = at;
    // A stamp equal to the label's is not written: every key has it.
    for (const key in state) entry.stamps[key] = at;
    entry.born = at;
    const extra = label.extra;
    if (!isRecord(extra)) return;
    const stamp = (
      clock: Json | undefined,
      session: Json | undefined,
    ): Stamp => [num(clock), names.session(session)];
    if (extra.l !== undefined) entry.life = num(extra.l);
    if (isList(extra.o)) entry.born = stamp(extra.o[0], extra.o[1]);
    if (extra.b !== undefined)
      entry.back = { parent: names.read(extra.b), pos: text(extra.p) };
    if (extra.u !== undefined) {
      this.#offTree = true;
      entry.parent = extra.u === 0 ? undefined : names.read(extra.u);
      entry.pos = text(extra.q);
      // Without a pointer it has no stamp either: an insert without one (see
      // `#birthStamp`) still applies.
      if (extra.u === 0) entry.at = undefined;
    }
    const stamps = list(extra.s);
    for (let at = 0; at < stamps.length; at += 3)
      entry.stamps[text(stamps[at])] = stamp(stamps[at + 1], stamps[at + 2]);
  }

  /** Rebuilds the labels once `Doc.fromJSON` built the tree. */
  load(json: JsonDoc | JsonTree) {
    const doc = this.#doc;
    const root = this.#rootEntry();
    root.node = doc.root;
    const fugue = this.#newFugue();
    this.#fugue = fugue;
    const stored = isTree(json) ? undefined : elementsOf(json)[5];
    if (isTree(json) || !isList(stored)) {
      // A document without labels: deterministic labels, same on every replica.
      const walk = (node: DocNode) => {
        for (let child = node.first; child; child = child.next) {
          const entry = this.#newEntry(child.id, 0, child.type);
          entry.node = child;
          entry.parent = node.id;
          // The same places on every replica that loads it.
          fugue.create(child.id, child.id, node.id, child.prev?.id);
          entry.pos = entry.key = child.id;
          entry.at = ZERO;
          for (const key in child["_state"]) entry.stamps[key] = ZERO;
          this.#entries.set(child.id, entry);
          walk(child);
        }
      };
      walk(doc.root);
      return;
    }
    const labels = new StoredLabels(stored, storedSessions(json, doc.root.id));
    this.#clock = labels.clock;
    labels.places(fugue, doc);
    labels.deleted((session, from, to, life) =>
      this.#deleted.add(session, from, to, life),
    );
    labels.aliases((old, renamed) =>
      (this.#aliases ??= new Map<string, string>()).set(old, renamed),
    );
    labels.visible(doc.root, (child, parent, label) => {
      const entry = this.#newEntry(child.id, 0, child.type);
      entry.node = child;
      entry.parent = parent.id;
      this.#restoreLabel(entry, label, labels, child["_state"]);
      // A cut keeps the view where it was shown and its pointer elsewhere.
      entry.key = entry.pos;
      entry.away = !!label.away;
      // Shown before its place arrived, it waits for it again.
      if (entry.away) this.#waitForPlace(entry.key, entry);
      this.#entries.set(child.id, entry);
    });
    labels.rootStamps((key, stamp) => (root.stamps[key] = stamp));
    labels.limbo((id, type, label, state) => {
      this.#offTree = true;
      const entry = this.#newEntry(id, 0, type);
      this.#restoreLabel(entry, label, labels, state);
      this.#entries.set(id, entry);
      if (type !== undefined) {
        entry.node = doc["_nodeFromTree"]([id, type, state]);
      } else {
        // Its insert has not arrived: it is not born yet, and the insert,
        // older than the move or write that made it known, still applies.
        entry.born = undefined;
        if (!isObjectEmpty(state)) entry.pending = state;
      }
      entry.key = entry.pos;
    });
    labels.pending((id, life, seen, own) => {
      this.#mergePending(id, life, seen);
      if (own) {
        this.#pending!.get(id)!.own = true;
        (this.#garbage ??= new Map<string, number>()).set(id, this.#clock);
      }
    });
    this.#rebuildAfterHydrate();
  }

  #rebuildAfterHydrate() {
    // Every node is shown where it points, as one that never moved: there is
    // no cycle to cut and nothing to link.
    if (!this.#offTree) return;
    // Limbo nodes are linked to the parents they already point to, and the
    // cycle cut is recomputed. Both are pure functions of the labels.
    const rootId = this.#doc.root.id;
    for (const entry of this.#entries.values()) {
      if (entry.id === rootId || !entry.node) continue;
      if (!entry.node.parent) this.#dirty.add(entry);
    }
    this.#cuts = this.#resolveCuts();
    for (const entry of this.#entries.values()) {
      if (entry.node && entry.id !== rootId) {
        const [, key] = this.#target(entry);
        entry.key = key;
        const shownIn = entry.node.parent;
        if (shownIn) entry.away = this.#isAway(key, shownIn.id);
        if (entry.away) this.#waitForPlace(key, entry);
        // A node shown away from a dead parent goes back when it revives.
        this.#refreshWaiting(entry);
      }
    }
    // Dirty limbo entries re-link under their (possibly invisible) parents.
    const order = this.#topDown([...this.#dirty], rootId);
    for (const entry of order) this.#place(entry);
    this.#dirty.clear();
  }

  #mergeSnapshot(stored: Json | undefined) {
    if (!isJsonDoc(stored)) return;
    const crdt = elementsOf(stored)[5];
    if (!isList(crdt)) return;
    // A snapshot is one of this document, which has its id.
    const id = this.#doc.root.id;
    const labels = new StoredLabels(crdt, storedSessions(stored, id));
    this.#clock = Math.max(this.#clock, labels.clock);
    labels.deleted((session, from, to, life) =>
      this.#mergeDelete([session, from, to, life]),
    );
    const ingest = (
      id: string,
      type: string | undefined,
      parent: string | undefined,
      label: Label,
      state: Record<string, string>,
    ) => {
      const scratch = this.#newEntry(id, 0, type);
      scratch.parent = parent;
      this.#restoreLabel(scratch, label, labels, state);
      const entry = this.#ensure(id, scratch.life);
      if (!entry) return;
      const wasTyped = entry.type !== undefined;
      if (type !== undefined) entry.type = type;
      if (scratch.parent !== undefined) {
        this.#mergePointer(
          entry,
          scratch.parent,
          scratch.pos,
          scratch.at!,
          scratch.back,
        );
      }
      if (!wasTyped && type !== undefined) this.#onTyped(entry);
      // As its insert would: state written before this life began is reset.
      if (type !== undefined) this.#mergeBirth(entry, scratch.born!);
      for (const key in state) {
        this.#mergeState(entry, key, state[key]!, scratch.stamps[key]!);
      }
      for (const key in scratch.stamps) {
        if (key in state) continue;
        // Only a typed node leaves a written value out: its key's default.
        const defaults = this.#doc["_resolvedNodeDefs"].get(entry.type!)!;
        const value = defaults.defaultStrings[key]!;
        this.#mergeState(entry, key, value, scratch.stamps[key]!);
      }
    };
    // The stored tree, read by a document of the same node types.
    const doc = this.#doc;
    const copy = Doc.fromJSON(
      {
        id,
        type: doc.root.type,
        extensions: [{ nodes: [...doc["_nodeDefs"]] }],
        nodeIdGenerator: doc["_idGen"],
      },
      stored,
    );
    labels.places(this.#fugue, copy);
    labels.visible(copy.root, (child, parent, label) =>
      ingest(child.id, child.type, parent.id, label, child["_stateToJson"]()),
    );
    labels.limbo((id, type, label, state) =>
      ingest(id, type, undefined, label, state),
    );
    labels.pending((id, life, seen) => this.#mergePending(id, life, seen));
  }
}

/** A stored state: each value as a JSON string. A label without one has `0`. */
function stateOf(value: Json | undefined) {
  const state: Record<string, string> = {};
  if (isRecord(value)) for (const key in value) state[key] = text(value[key]);
  return state;
}

const ZERO: Stamp = [0, ""];

/** A label as stored: its key, its stamp, and what else it has. */
type Label = {
  pos: string;
  at: Stamp;
  extra: Json | undefined;
  /** Shown away from its place (see `Entry.away`). */
  away?: boolean;
};

/**
 * How the place of a shown node is stored, `1` if it is not the node's id
 * (in `places`) plus `2` if the node is shown away from it.
 */
function placeKind(entry: Entry, id: string, places: string[]) {
  const own = entry.pos === id;
  if (!own) places.push(entry.pos);
  return (own ? 0 : 1) + (entry.away ? 2 : 0);
}

/** @internal - Test helper: the FugueMax text of a CRDT document. */
export function _INTERNAL_crdtTextStore(doc: Doc): TextStore {
  const store = storeOf(doc);
  if (!(store instanceof TextStore)) throw new Error("Not a CRDT document");
  return store;
}

/**
 * Stamps and node ids by their session in the document's table: `0` for
 * `""`, the session of every stamp of a node never moved (a column of
 * zeros), else one more than its index.
 */
const sessionWriter = (table: SessionTable) => {
  const index = (session: string) => (session ? table.index(session) + 1 : 0);
  return { index, write: (id: string) => writeId(id, index) };
};

/**
 * The labels of a stored document, its last element (see `elementsOf`):
 *
 * `[clock, columns, deleted, rootStamps, places, extras, limbo, aliases,
 * pending, lists]` (see `LABELS_*`), without the empty ones at the end.
 * Node ids are written by the sessions of the document's table (see
 * `writeId`), and so are stamps, `[clock, session]`.
 *
 * - `columns`, one number per visible node in the order of the stored tree:
 *   the session of its stamp, its clock as the difference from the previous
 *   node's, and how its place is stored (see `placeKind`). `places` lists
 *   the places that are not the node's id.
 * - `extras`: `[index, extra, …]`, what the labels of those nodes have that
 *   the columns leave out (see `#extra`).
 * - `deleted`: `[[session, from, to, life, …], …]`.
 * - `limbo`: `[[id, type | 0, [key, clock, session, extra?], state | 0], …]`,
 *   the labels of nodes not shown.
 * - `aliases`: `[old, new, …]`; `rootStamps`: `[key, clock, session, …]`;
 *   `pending`: `[id, life, clock, session, own, …]`.
 * - `lists`: the places of every list (see `FugueSiblings.toJSON`).
 */
class StoredLabels {
  readonly clock: number;
  readonly #stored: readonly Json[];
  readonly #sessions: readonly string[];

  constructor(stored: readonly Json[], sessions: readonly string[]) {
    this.#stored = stored;
    this.#sessions = sessions;
    this.clock = num(stored[LABELS_CLOCK]);
  }

  /** A session `sessionWriter` wrote. */
  session(index: Json | undefined): string {
    return this.#sessions[num(index) - 1] ?? "";
  }

  /** A node id `sessionWriter` wrote. */
  read(written: Json | undefined): string {
    return readId(text(written), (index) => this.session(index));
  }

  /** The stored places of the stored tree `doc`. */
  places(fugue: FugueSiblings, doc: Doc) {
    fugue.load(
      this.#stored[LABELS_LISTS],
      (list) => childIds(doc, list),
      this.#sessions,
    );
  }

  #label(value: Json | undefined): Label {
    const label = list(value);
    return {
      pos: text(label[0]),
      at: [num(label[1]), this.session(label[2])],
      extra: label[3],
    };
  }

  /** Each node under `root`, in preorder, with its parent and its label. */
  visible(
    root: DocNode,
    visit: (child: DocNode, parent: DocNode, label: Label) => void,
  ) {
    const stored = this.#stored;
    const [sessions, clocks, kinds] = splitColumns(
      text(stored[LABELS_COLUMNS]),
      3,
    ).map((column) => new ColumnReader(column));
    const places = list(stored[LABELS_PLACES]).map(text);
    const extras = new Map<number, Json | undefined>();
    const extraList = list(stored[LABELS_EXTRAS]);
    for (let at = 0; at < extraList.length; at += 2)
      extras.set(num(extraList[at]), extraList[at + 1]);
    let place = 0;
    let index = 0;
    let clock = 0;
    const walk = (parent: DocNode) => {
      for (let child = parent.first; child; child = child.next) {
        const session = this.session(sessions!.next());
        clock += clocks!.nextSigned();
        const kind = kinds!.next();
        visit(child, parent, {
          pos: kind & 1 ? places[place++]! : child.id,
          at: [clock, session],
          extra: extras.get(index),
          away: kind > 1,
        });
        index++;
        walk(child);
      }
    };
    walk(root);
  }

  deleted(
    visit: (session: string, from: number, to: number, life: number) => void,
  ) {
    for (const group of list(this.#stored[LABELS_DELETED])) {
      const [session, ...runs] = list(group);
      for (let at = 0; at < runs.length; at += 3)
        visit(
          this.session(session),
          num(runs[at]),
          num(runs[at + 1]),
          num(runs[at + 2]),
        );
    }
  }

  limbo(
    visit: (
      id: string,
      type: string | undefined,
      label: Label,
      state: Record<string, string>,
    ) => void,
  ) {
    for (const item of list(this.#stored[LABELS_LIMBO])) {
      const [id, type, label, state] = list(item);
      visit(
        this.read(id),
        typeof type === "string" ? type : undefined,
        this.#label(label),
        stateOf(state),
      );
    }
  }

  aliases(visit: (old: string, renamed: string) => void) {
    const aliases = list(this.#stored[LABELS_ALIASES]);
    for (let at = 0; at < aliases.length; at += 2)
      visit(this.read(aliases[at]), this.read(aliases[at + 1]));
  }

  rootStamps(visit: (key: string, stamp: Stamp) => void) {
    const stamps = list(this.#stored[LABELS_ROOT_STAMPS]);
    for (let at = 0; at < stamps.length; at += 3)
      visit(text(stamps[at]), [
        num(stamps[at + 1]),
        this.session(stamps[at + 2]),
      ]);
  }

  pending(
    visit: (id: string, life: number, seen: Stamp, own: boolean) => void,
  ) {
    const pending = list(this.#stored[LABELS_PENDING]);
    for (let at = 0; at < pending.length; at += 5)
      visit(
        this.read(pending[at]),
        num(pending[at + 1]),
        [num(pending[at + 2]), this.session(pending[at + 3])],
        pending[at + 4] === 1,
      );
  }
}

const isTree = (json: JsonDoc | JsonTree): json is JsonTree =>
  typeof json[0] === "string";

/** A stored document of the current format, as a snapshot carries it. */
const isJsonDoc = (json: unknown): json is JsonDoc =>
  Array.isArray(json) && Array.isArray(json[0]) && typeof json[1] === "string";

/** Text that converges without a server: FugueMax, with tombstones. */
const fugueText = textState(TextStore);

/** The labels an engine row holds (see `encodeRecord`). */
function decodeRecord(
  row: readonly Json[],
  sessions: Sessions,
  places: Place[],
  rootId: string,
): LabelRecord {
  // One closure for every id: the rest are loops over the row's fields.
  const id = (written: Json | undefined) => sessions.read(written);
  const lives: Record<string, number> = {};
  const livesList = row[5];
  if (isList(livesList))
    for (let index = 0; index < livesList.length; index += 2)
      lives[id(livesList[index])] = Number(livesList[index + 1]);
  const inserts: InsertGroup[] = [];
  let previous: Place | undefined;
  const groups = row[2];
  if (isList(groups))
    for (const group of groups) {
      if (!isList(group)) continue;
      const parent = group[0] === 0 ? 0 : id(group[0]);
      const list = parent === 0 ? rootId : parent;
      const decoded: InsertGroup = [parent];
      let lastId = "";
      let lastType = "";
      for (let at = 1; at < group.length; at++) {
        const node = group[at];
        // A run: as many nodes after the last one, each in its own place.
        if (typeof node === "number")
          for (let k = 0; k < node; k++) {
            const next = nextId(lastId);
            // Broken: a count without a node before it.
            if (next === undefined) break;
            lastId = next;
            previous = FugueSiblings.read(
              undefined,
              undefined,
              lastId,
              lastId,
              list,
              previous,
              id,
            );
            places.push(previous);
            decoded.push([lastId, lastType, lastId]);
          }
        if (!isList(node)) continue;
        const nodeId = id(node[0]);
        const later = Number(node[4] ?? 0);
        const place = node[5] === undefined ? nodeId : id(node[5]);
        previous = FugueSiblings.read(
          node[2],
          node[3],
          place,
          nodeId,
          list,
          previous,
          id,
        );
        places.push(previous);
        lastId = nodeId;
        lastType = text(node[1]);
        decoded.push(
          later > 0
            ? [nodeId, lastType, place, later]
            : [nodeId, lastType, place],
        );
      }
      inserts.push(decoded);
    }
  const moves: MoveRecord[] = [];
  const movesList = row[3];
  if (isList(movesList))
    for (const move of movesList) {
      if (!isList(move)) continue;
      const [
        node,
        written,
        pos,
        origin,
        right,
        life = 0,
        backParent = "",
        backPos = "",
      ] = move;
      const nodeId = id(node);
      const parent = written === 0 ? 0 : id(written);
      const place = id(pos);
      if (origin !== false) {
        previous = FugueSiblings.read(
          origin,
          right,
          place,
          nodeId,
          parent === 0 ? rootId : parent,
          previous,
          id,
        );
        places.push(previous);
      }
      // See `moveTail`.
      const hasBack = backParent !== false;
      moves.push([
        nodeId,
        parent,
        place,
        !hasBack
          ? null
          : backParent === ""
            ? parent
            : backParent === 0
              ? 0
              : id(backParent),
        hasBack ? (backPos === "" ? nodeId : id(backPos)) : null,
        Number(life),
      ]);
    }
  const deletes: DeleteRecord[] = [];
  const deletesList = row[4];
  if (isList(deletesList))
    for (const del of deletesList)
      if (isList(del))
        deletes.push([
          sessions.session(Number(del[0])),
          Number(del[1]),
          Number(del[2]),
          Number(del[3]),
        ]);
  const pending: PendingRecord[] = [];
  const pendingList = row[6];
  if (isList(pendingList))
    for (const each of pendingList)
      if (isList(each))
        pending.push([
          Number(each[0]),
          sessions.session(Number(each[1])),
          sessions.session(Number(each[2])),
          Number(each[3]),
          Number(each[4]),
          Number(each[5]),
        ]);
  return {
    lamport: Number(row[1]) + firstClock(inserts),
    session: sessions.session(Number(row[7] ?? 0)),
    inserts,
    moves,
    deletes,
    lives,
    pending,
  };
}

/**
 * The labels engine for `DocConfig.crdt`: each node carries a label (its
 * parent, its position among its siblings and a stamp per field), and the
 * newest stamp wins. A change that arrives late costs the same as one on time.
 */
export const labelsEngine = (options?: CrdtOptions): CrdtEngineFactory =>
  Object.assign((doc: Doc) => new Engine(doc, options), { text: fugueText });

/**
 * A whole stored document as a batch: a replica that lost what it sent (a
 * crash) sends this instead. Merging it twice changes nothing.
 */
export const labelsSnapshot = (json: JsonDoc): Operations => {
  const elements: readonly (Json | undefined)[] = json;
  const stored = elements.filter((element) => element !== undefined);
  return ["", [SNAPSHOT, stored]];
};
