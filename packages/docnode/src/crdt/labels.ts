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
  isObjectEmpty,
  withTransaction,
} from "../utils.js";
import { decodeOperations, encodeOperations } from "../wire.js";
import {
  ColumnReader,
  ColumnWriter,
  frontCode,
  joinColumns,
  SessionTable,
  splitColumns,
} from "../columns.js";
import { FORMAT, storedSessions, withCrdt } from "../jsonDoc.js";
import { IdRanges } from "../idRanges.js";
import { applyLocal } from "./local.js";
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
   * placed in its parent (see `_prevSibling`).
   */
  away: boolean;
};

/** JSON has `null`, and the labels travel as JSON. */
// eslint-disable-next-line @typescript-eslint/no-restricted-types
type Nil = null;

const compare = (a: Stamp, b: Stamp) => compareStamps(a[0], a[1], b[0], b[1]);

/** `[session, clock]`. An id that is not `session.clock` is its own session. */
function parseId(id: string): [string, number] {
  const dot = lastDot(id);
  const clock = dot > 0 ? clockAt(id, dot) : -1;
  return clock < 0 ? [id, 0] : [id.slice(0, dot), clock];
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
 * The only place that writes the labels layout. Siblings are ordered by
 * places (see `FugueSiblings.writePlace`). An insert is `[id, type, origin?,
 * right?]`, or `[id, type, origin, right, life, place]` for a place that is
 * not the node's id; a move is `[id, parent, place, origin?, right?]`, then
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
    for (const [id, type, pos, life] of nodes)
      group.push(
        placed(
          [ref(id), type],
          pos,
          life || pos !== id ? [life ?? 0, write(pos)] : [],
        ),
      );
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
 * The clock of the first node a record inserts, which its Lamport clock is
 * written after: an author that only types keeps the two close.
 */
const firstClock = (inserts: InsertGroup[]) => {
  const first = inserts[0]?.[1];
  return first ? parseId(first[0])[1] : 0;
};

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
      for (let at = 1; at < group.length; at++) {
        const node = group[at];
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
        decoded.push(
          later > 0
            ? [nodeId, text(node[1]), place, later]
            : [nodeId, text(node[1]), place],
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

const isList = (value: Json | undefined): value is readonly Json[] =>
  Array.isArray(value);

/** A string of a row, or "" where a row that came broken has something else. */
const text = (value: Json | undefined) =>
  typeof value === "string" ? value : "";

const isEmpty = (value: Json | undefined) =>
  value === null || (Array.isArray(value) && value.length === 0);

type Pending = { life: number; seen: Stamp; own: boolean };

const ROOT_POS = "";

/** Steps up from a node before `_hasNewCycle` keeps the ids it walked. */
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
  protected _entries = new Map<string, Entry>();
  protected _deleted = new IdRanges();
  protected _clock = 0;
  private _session: string | undefined;
  /** Entries that wait for a parent that is missing, by the missing parent. */
  protected _waiting = new Map<string, Set<Entry>>();
  /** The cycle cut: node id -> where it is shown instead of its pointer. */
  protected _cuts = new Map<string, Back>();
  private readonly _doc: Doc;
  private readonly _generator: Doc["_nodeIdGenerator"];
  private readonly _options: Required<CrdtOptions>;
  /** The diff of the transaction that merged remote labels, if any. */
  private _remoteDiff: Diff | undefined;
  private _dirty = new Set<Entry>();
  /** Reused by `_mergeRecord`: the inserts of a record without a stamp. */
  private readonly _unstamped = new Set<string>();
  /** Entries whose place may not fit their neighbours: placed again. */
  private _forced = new Set<Entry>();
  private _dropped: Entry[] = [];
  private _repairing: { lamport: number } | undefined;
  private _normalizeClock = -1;
  private _normalizeCount = 0;
  /** What `Doc` does without an engine, for what the engine passes on. */
  private readonly _apply: Doc["applyOperations"];
  /** `newId`: old id -> id it got when its delete was undone. */
  protected _aliases = new Map<string, string>();
  /** Descendants of deleted nodes: they die unless a move took them out. */
  protected _pending = new Map<string, Pending>();
  /** Whether a stored node was loaded away from where it points, or hidden. */
  private _offTree = false;
  /** Ids this replica must remove for good, with the clock they were queued. */
  protected _garbage = new Map<string, number>();
  /** The places of every parent's children (FugueMax, see `./fugue.ts`). */
  private _fugue: FugueSiblings;
  /** The session of the places this replica makes. */
  private _ownPlaces: string | undefined;
  /** Entries waiting for a place to be shown there, by the place. */
  private readonly _placeWaiters = new Map<string, Set<Entry>>();

  constructor(doc: Doc, options: CrdtOptions = {}) {
    this._doc = doc;
    this._options = {
      undo: options.undo ?? "lives",
      gcDelay: options.gcDelay ?? 100,
    };
    this._fugue = this._newFugue();
    this._generator = doc["_nodeIdGenerator"];
    // The engine takes over what it changes of the document: it is created
    // before the extensions and the undo manager, so its change listener is
    // the first one, and it turns the event into what it sends.
    doc["_createNodeId"] = () => this._normalizeId() ?? this._generator(doc);
    this._apply = doc.applyOperations.bind(doc);
    doc.applyOperations = (operations, flags) =>
      this._applyOperations(operations, flags);
    const toJSON = doc.toJSON.bind(doc);
    doc.toJSON = (options) => this._toJSON(toJSON(options));
    doc.onChange((event) => this._commit(event));
  }

  /**
   * A node created by normalize gets an id every replica computes alike, so
   * two replicas repairing the same state end up with one node, not two.
   */
  private _normalizeId() {
    const doc = this._doc;
    const stage = doc["_lifeCycleStage"];
    if (!this._repairing && stage !== "normalize" && stage !== "normalize2") {
      return undefined;
    }
    if (this._normalizeClock !== this._clock) {
      this._normalizeClock = this._clock;
      this._normalizeCount = 0;
    }
    const id = `r${this._clock}.${this._normalizeCount}`;
    if (!doc["_idGen"].validate(id)) return undefined;
    this._normalizeCount++;
    return id;
  }

  /* ----------------------------------- fugue ----------------------------------- */

  private _newFugue() {
    return new FugueSiblings((id) => {
      if (this._placeWaiters.size === 0) return;
      const waiting = this._placeWaiters.get(id);
      if (!waiting) return;
      this._placeWaiters.delete(id);
      // Placed again, from the end to its place.
      for (const entry of waiting) this._dirty.add(entry);
    });
  }

  /** If `place` is not in its list yet, `entry` is placed again when it is. */
  private _waitForPlace(place: string, entry: Entry) {
    if (this._fugue.has(place)) return;
    let waiting = this._placeWaiters.get(place);
    if (!waiting) this._placeWaiters.set(place, (waiting = new Set()));
    waiting.add(entry);
  }

  /** A session only this replica uses, for the places it makes. */
  private _placeSession() {
    return (this._ownPlaces ??= parseId(this._generator(this._doc))[0]);
  }

  /** Whether a node shown at `key` under `parent` is away from it. */
  private _isAway(key: string, parent: string) {
    return this._fugue.listOf(key) !== parent;
  }

  /**
   * A new place for each node of a run that changed place, right
   * after the place of the node before it. A first life's place has the
   * node's id; `mint` names any other.
   */
  private _placeRun(run: DocNode[], inserted: Set<string>, mint: () => string) {
    const first = run[0]!;
    const parent = first.parent!;
    // Nodes shown away from their place go last (see `_prevSibling`): the
    // run goes after the last placed one, and is sorted again.
    let before = first.prev;
    while (before && this._entries.get(before.id)!.away) before = before.prev;
    let left = before ? this._keyOf(before) : undefined;
    const list = parent.id;
    const ids = run.map((node) => {
      const entry = this._entries.get(node.id);
      const fresh =
        inserted.has(node.id) && !entry && this._deadLife(node.id) < 0;
      const id = fresh ? node.id : mint();
      this._fugue.create(id, node.id, list, left);
      left = id;
      return id;
    });
    return { ids, resort: before !== first.prev };
  }

  /* ---------------------------------- session ---------------------------------- */

  /** A fresh local id tells the session without spending an id on it. */
  private _sessionId(fresh: Set<string>) {
    if (this._session === undefined) {
      const doc = this._doc;
      const [first] = fresh;
      const id =
        first !== undefined && this._deadLife(first) < 0
          ? first
          : this._generator(doc);
      this._session = parseId(id)[0];
    }
    return this._session;
  }

  /* ----------------------------------- labels ----------------------------------- */

  private _rootEntry() {
    const { root } = this._doc;
    let entry = this._entries.get(root.id);
    if (!entry) {
      entry = this._newEntry(root.id, 0, root.type);
      entry.node = root;
      entry.at = [0, ""];
      entry.key = ROOT_POS;
      this._entries.set(root.id, entry);
    }
    return entry;
  }

  private _newEntry(id: string, life: number, type?: string): Entry {
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

  private _deadLife(id: string) {
    if (this._deleted.isEmpty()) return -1;
    const [session, clock] = parseId(id);
    return this._deleted.get(session, clock);
  }

  private _ensure(id: string, life: number): Entry | undefined {
    if (this._deadLife(id) >= life) return undefined;
    let entry = this._entries.get(id);
    if (entry) {
      if (entry.life > life) return undefined;
      if (entry.life === life) return entry;
      this._kill(entry);
    }
    entry = this._newEntry(id, life);
    this._entries.set(id, entry);
    return entry;
  }

  /**
   * Forgets what was pending for this life of the node. A record for a later
   * life may have arrived before that life's insert, and stays.
   */
  private _dropPending(entry: Entry) {
    if ((this._pending.get(entry.id)?.life ?? 0) <= entry.life)
      this._pending.delete(entry.id);
  }

  private _kill(entry: Entry) {
    this._entries.delete(entry.id);
    this._dropPending(entry);
    this._garbage.delete(entry.id);
    this._dropped.push(entry);
    for (const parent of this._watchedParents(entry))
      this._unwait(parent, entry);
    const waiters = this._waiting.get(entry.id);
    waiters?.forEach((waiter) => this._dirty.add(waiter));
    if (entry.node) this._dirtyChildren(entry.node);
  }

  /** A hidden node can still link children that were removed since. */
  private _dirtyChildren(node: DocNode) {
    node.children().forEach((child) => {
      const childEntry = this._entries.get(child.id);
      /* v8 ignore next -- @preserve: a child killed in the same batch (fuzz). */
      if (childEntry) this._dirty.add(childEntry);
    });
  }

  private _wait(parent: string, entry: Entry) {
    let waiters = this._waiting.get(parent);
    if (!waiters) {
      waiters = new Set();
      this._waiting.set(parent, waiters);
    }
    waiters.add(entry);
  }

  private _unwait(parent: string, entry: Entry) {
    const waiters = this._waiting.get(parent);
    if (!waiters) return;
    waiters.delete(entry);
    if (waiters.size === 0) this._waiting.delete(parent);
  }

  /* ------------------------------- local commits ------------------------------- */

  /**
   * The first change listener: the engine turns the event into what it sends.
   * `operations` becomes the labels (or, for a remote batch, the batch as it
   * came, to pass on).
   */
  private _commit(event: ChangeEvent) {
    const doc = this._doc;
    this._rootEntry();
    if (this._remoteDiff === doc["_diff"]) {
      // The event sends on the batch that came (see `mergeEvent`).
      this._remoteDiff = undefined;
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
    const session = this._repairing ? "" : this._sessionId(fresh);
    const lamport = this._repairing ? this._repairing.lamport : ++this._clock;
    const stamp: Stamp = [lamport, session];

    const moved = new Map<string, Back>();
    for (const id of diff.moved) {
      moved.set(id, this._shownBack(this._entries.get(id)!));
    }

    const inserts: InsertGroup[] = [];
    const moves: MoveRecord[] = [];
    const lives: Record<string, number> = {};
    this._assignPositions(fresh, moved, stamp, inserts, moves, lives);

    const [deletes, pending] = this._commitDeletes(diff.deleted);

    const states = classic[1];
    for (const id in states) {
      const entry = this._entries.get(id)!;
      const stamps = entry.stamps;
      // The values an insert writes share its stamp (see `_birthStamp`).
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
    this._affirm(stamp, moves, moved);
    for (const entry of this._forced) this._dirty.add(entry);
    if (
      this._cuts.size > 0 ||
      this._dirty.size > 0 ||
      this._dropped.length > 0
    ) {
      // The local edit may dissolve or form a cut: same pure function as remote.
      doc["_lifeCycleStage"] = "update";
      this._reconcile();
      doc["_lifeCycleStage"] = "change";
    }
    if (inverse[0].length !== inverseLength)
      event.inverseOperations = compactOperations(inverse);
    event.operations = this._batch(
      { lamport, session, inserts, moves, deletes, lives, pending },
      textAndState,
    );
  }

  /** A batch with the labels of `record`, and the text and state of `classic`. */
  private _batch(record: LabelRecord, classic: Operations = [""]): Operations {
    const sessions = new Sessions(classic[0]);
    return withEngineRow(
      sessions,
      encodeRecord(record, sessions, this._fugue),
      textRows(classic),
    );
  }

  /** Where the author saw this node before moving it. */
  private _shownBack(entry: Entry): Back {
    // A node the user could move was shown somewhere.
    return { parent: this._target(entry)[0]!, pos: entry.key };
  }

  private _affirm(stamp: Stamp, moves: MoveRecord[], moved: Map<string, Back>) {
    if (moved.size === 0 || this._cuts.size === 0) return;
    const root = this._doc.root.id;
    const wire = (id: string) => (id === root ? 0 : id);
    for (const [id, cut] of this._cuts) {
      const entry = this._entries.get(id);
      if (!entry || moved.has(id)) continue;
      const move: MoveBase = [id, wire(cut.parent), cut.pos, null, null];
      moves.push(entry.life > 0 ? [...move, entry.life] : move);
      entry.parent = cut.parent;
      entry.pos = cut.pos;
      entry.at = stamp;
      entry.back = undefined;
      this._cuts.delete(id);
    }
  }

  private _assignPositions(
    inserted: Set<string>,
    moved: Map<string, Back>,
    stamp: Stamp,
    inserts: InsertGroup[],
    moves: MoveRecord[],
    lives: Record<string, number>,
  ) {
    const doc = this._doc;
    const root = doc.root;
    const wire = (id: string): string | 0 => (id === root.id ? 0 : id);
    const groups = new Map<DocNode, InsertGroup>();
    const done = new Set<string>();
    const dirty = (id: string) => inserted.has(id) || moved.has(id);
    const assign = (node: DocNode, pos: string) => {
      done.add(node.id);
      const parent = node.parent!;
      const wireParent = wire(parent.id);
      let entry = this._entries.get(node.id);
      let at = stamp;
      if (inserted.has(node.id)) {
        // After its last dead life, and never before a life others already
        // gave it (a concurrent undo revived it while it was hidden here).
        const life = Math.max(this._deadLife(node.id) + 1, entry?.life ?? 0);
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
          this._dirtyChildren(entry.node);
          this._unlink(entry.node);
        }
        entry = this._newEntry(node.id, life, node.type);
        at = entry.born = this._birthStamp(node.id, life, pos, stamp);
        this._entries.set(node.id, entry);
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
        this._cuts.delete(node.id);
      }
      entry.node = node;
      entry.parent = parent.id;
      entry.pos = pos;
      entry.at = at;
      entry.key = pos;
      entry.away = false;
      this._dirty.add(entry);
      this._waiting.get(node.id)?.forEach((waiter) => this._dirty.add(waiter));
    };
    let minted = 0;
    // A repair makes the same places on every replica. Anything else is a
    // place of this replica, `session~.clock`: a session only it uses (not
    // that of its stamps, which may be another's: that of the first node it
    // inserts) and a clock of its own, the stamp's and then new ones.
    const mint = () =>
      this._repairing
        ? `~${minted++ || ""}.${numberToBase64(stamp[0])}`
        : `${this._placeSession()}~.${numberToBase64(minted++ === 0 ? stamp[0] : ++this._clock)}`;
    const process = (start: DocNode) => {
      let first = start;
      while (first.prev && dirty(first.prev.id)) first = first.prev;
      const run: DocNode[] = [];
      for (let cur: DocNode | undefined = first; cur && dirty(cur.id); ) {
        run.push(cur);
        cur = cur.next;
      }
      const { ids, resort } = this._placeRun(run, inserted, mint);
      run.forEach((node, i) => assign(node, ids[i]!));
      if (resort)
        for (const node of run) this._forced.add(this._entries.get(node.id)!);
    };
    for (const id of [...inserted, ...moved.keys()]) {
      if (done.has(id)) continue;
      const node = doc.getNodeById(id);
      if (node) process(node);
    }
  }

  private _keyOf(node: DocNode) {
    return this._entries.get(node.id)!.key;
  }

  /**
   * A deleted node dies for good. Its descendants stay pending: they die unless
   * a concurrent move takes them out of the subtree first.
   */
  private _commitDeletes(
    deleted: Map<string, DocNode>,
  ): [DeleteRecord[], PendingRecord[]] {
    const dead: [string, number][] = [];
    const pending = new Map<string, [Stamp, string, number, number[]]>();
    for (const [id, node] of deleted) {
      const entry = this._entries.get(id)!;
      if (node.parent && deleted.has(node.parent.id)) {
        const seen = entry.at!;
        // A remote delete of an ancestor may have seen a later pointer: the
        // latest one decides, whatever the order they arrive in.
        const known = this._pending.get(id);
        const latest =
          known?.life === entry.life && compare(known.seen, seen) > 0
            ? known.seen
            : seen;
        // A later life's pending stays, as `_mergePending` keeps it when this
        // record comes back.
        if (!known || known.life <= entry.life)
          this._pending.set(id, { life: entry.life, seen: latest, own: true });
        this._garbage.set(id, this._clock);
        // Placed again so it waits for its parent: an undo may bring it back.
        this._dirty.add(entry);
        const [owner, clock] = parseId(id);
        const key = `${seen[0]} ${seen[1]} ${owner} ${entry.life}`;
        const group = pending.get(key) ?? [seen, owner, entry.life, []];
        group[3].push(clock);
        pending.set(key, group);
        continue;
      }
      dead.push([id, entry.life]);
      this._forget(entry);
    }
    this._collectGarbage(dead);
    const records: PendingRecord[] = [];
    for (const [seen, owner, life, clocks] of pending.values()) {
      for (const [from, to] of runsOf(clocks)) {
        records.push([seen[0], seen[1], owner, from, to, life]);
      }
    }
    return [this._deadRanges(dead), records];
  }

  /** Removes an entry this replica deleted itself. */
  private _forget(entry: Entry) {
    this._entries.delete(entry.id);
    this._dropPending(entry);
    this._garbage.delete(entry.id);
    for (const parent of this._watchedParents(entry)) {
      this._unwait(parent, entry);
    }
  }

  /**
   * Removes for good what this replica queued long enough ago: descendants its
   * deletes left pending and its own inserts under a deleted parent. A delete
   * is the same for every replica in any order, so this is safe in P2P; what
   * it costs is that a move or an undo arriving later cannot rescue them.
   */
  private _collectGarbage(dead: [string, number][]) {
    for (const [id, queued] of this._garbage) {
      if (this._clock - queued < this._options.gcDelay) continue;
      const entry = this._entries.get(id);
      this._garbage.delete(id);
      if (!entry || this._isPlaced(entry)) continue;
      // Hidden only while its parent has not arrived: not garbage.
      /* v8 ignore next -- @preserve: a hidden own node whose parent is alive. */
      if (!this._isDoomed(entry) && !this._parentGone(entry)) continue;
      dead.push([id, entry.life]);
      this._kill(entry);
    }
  }

  private _parentGone(entry: Entry) {
    const parent = entry.parent!;
    const parentEntry = this._entries.get(parent);
    return parentEntry
      ? this._isDoomed(parentEntry)
      : this._deadLife(parent) >= 0;
  }

  private _isPlaced(entry: Entry) {
    const node = entry.node;
    return node !== undefined && this._doc["_nodeMap"].get(node.id) === node;
  }

  private _deadRanges(dead: [string, number][]): DeleteRecord[] {
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
          this._deleted.add(session, from, to, life);
        }
      }
    }
    return records;
  }

  /* --------------------------------- remote merge -------------------------------- */

  /** `doc.applyOperations`: labels merge, anything else is a local edit. */
  private _applyOperations(operations: Operations, flags?: TransactionFlags) {
    const record = engineRow(operations, RECORD);
    const snapshot = engineRow(operations, SNAPSHOT);
    if (!record && !snapshot) {
      // An undo, which may name nodes that changed since.
      return applyLocal(this._apply, operations, flags, (draft) =>
        this._prepareClassic(draft),
      );
    }
    const doc = this._doc;
    if (doc["_lifeCycleStage"] === "update") doc.forceCommit();
    const sessions = new Sessions(operations[0]);
    const [text, states] = decodeOperations(withoutEngineRow(operations));
    // Never undoable: only what this replica did is.
    doc["_transactionFlags"] = { ...flags, skipUndo: true };
    withTransaction(
      doc,
      () => {
        this._rootEntry();
        this._remoteDiff = doc["_diff"];
        if (record) {
          const places: Place[] = [];
          const labels = decodeRecord(record, sessions, places, doc.root.id);
          for (const place of places) this._fugue.add(place);
          this._mergeRecord(labels, states);
        } else this._mergeSnapshot(snapshot![1]);
        this._reconcile();
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
    this._remoteDiff = undefined;
    doc["_event"] = undefined;
    if (
      listeners.size > 0 &&
      doc["_lifeCycleStage"] === "idle" &&
      !doc["_isForceCommitCallback"]
    )
      this._repair();
  }

  private _mergeRecord(record: LabelRecord, states: StatePatch) {
    const { lamport, session, inserts, moves, deletes, lives, pending } =
      record;
    this._clock = Math.max(this._clock, lamport);
    const stamp: Stamp = [lamport, session];
    deletes.forEach((del) => this._mergeDelete(del));
    pending.forEach(([seenLamport, seenSession, owner, from, to, life]) => {
      for (let clock = from; clock <= to; clock++) {
        this._mergePending(this._idOf(owner, clock), life, [
          seenLamport,
          seenSession,
        ]);
      }
    });
    // Inserts without a stamp, and the values written with them.
    const unstamped = this._unstamped;
    unstamped.clear();
    inserts.forEach(([parent, ...nodes]) => {
      for (const insert of nodes) {
        const [id, type, pos] = insert;
        const life = insert.length > 3 ? insert[3]! : 0;
        const entry = this._ensure(id, life);
        if (!entry) continue;
        const wasTyped = entry.type !== undefined;
        entry.type = type;
        const born = this._birthStamp(id, life, pos, stamp);
        if (born === ZERO) unstamped.add(id);
        this._mergePointer(entry, this._parentId(parent), pos, born, undefined);
        if (!wasTyped) this._onTyped(entry);
        this._mergeBirth(entry, born);
      }
    });
    moves.forEach((move) => {
      const [id, parent, pos, backParent, backPos, life = 0] = move;
      const entry = this._ensure(id, life);
      if (!entry) return;
      const back =
        backParent === null || backPos === null
          ? undefined
          : { parent: this._parentId(backParent), pos: backPos };
      this._mergePointer(entry, this._parentId(parent), pos, stamp, back);
    });
    for (const id in states) {
      const entry = this._ensure(id, lives[id] ?? 0);
      if (!entry) continue;
      const values = states[id]!;
      const at = unstamped.has(id) ? ZERO : stamp;
      for (const key in values) this._mergeState(entry, key, values[key]!, at);
    }
  }

  /**
   * The first life of a node at its own place has no stamp (it is
   * `ZERO`). Anything that names the node (a move, a write, a cycle it is in)
   * comes from a replica that saw the insert, so it has a newer stamp anyway,
   * and the stored labels of nodes never moved need no stamp columns.
   */
  private _birthStamp(id: string, life: number, pos: string, stamp: Stamp) {
    return life === 0 && pos === id ? ZERO : stamp;
  }

  private _parentId(wire: string | 0) {
    return wire === 0 ? this._doc.root.id : wire;
  }

  private _mergeDelete([session, from, to, life]: DeleteRecord) {
    this._deleted.add(session, from, to, life);
    for (let clock = from; clock <= to; clock++) {
      for (const id of this._idsOf(session, clock)) {
        const entry = this._entries.get(id);
        if (entry && entry.life <= life) this._kill(entry);
      }
    }
  }

  /** A whole-id session names the id itself, with no clock suffix. */
  private _idsOf(session: string, clock: number) {
    const id = this._idOf(session, clock);
    return clock === 0 ? [id, session] : [id];
  }

  private _idOf(session: string, clock: number) {
    return `${session}.${numberToBase64(clock)}`;
  }

  private _mergePending(id: string, life: number, seen: Stamp) {
    const whole = id.slice(0, -2);
    const wholeId = id.endsWith(".-") && this._entries.has(whole);
    for (const candidate of wholeId ? [id, whole] : [id]) {
      if (this._deadLife(candidate) >= life) continue;
      // A later life of the node replaced this one: its record, applied
      // again, is old news.
      if ((this._entries.get(candidate)?.life ?? life) > life) continue;
      const current = this._pending.get(candidate);
      if (
        current &&
        (current.life > life ||
          (current.life === life && compare(current.seen, seen) >= 0))
      ) {
        continue;
      }
      this._pending.set(candidate, { life, seen, own: current?.own ?? false });
      const entry = this._entries.get(candidate);
      if (entry) this._dirty.add(entry);
    }
  }

  private _onTyped(entry: Entry) {
    const doc = this._doc;
    const node = doc["_nodeFromTree"]([entry.id, entry.type!, {}]);
    entry.node = node;
    for (const key in entry.pending) {
      this._writeState(entry, key, entry.pending[key]!);
    }
    entry.pending = undefined;
    this._waiting.get(entry.id)?.forEach((waiter) => this._dirty.add(waiter));
    this._dirty.add(entry);
  }

  private _mergePointer(
    entry: Entry,
    parent: string,
    pos: string,
    stamp: Stamp,
    back: Back | undefined,
  ) {
    if (entry.at && compare(stamp, entry.at) <= 0) return;
    if (entry.parent !== undefined) this._unwait(entry.parent, entry);
    entry.parent = parent;
    entry.pos = pos;
    entry.at = stamp;
    entry.back = back;
    this._dirty.add(entry);
  }

  /** An insert sets every key: older writes go back to the default. */
  private _mergeBirth(entry: Entry, stamp: Stamp) {
    if (entry.born && compare(stamp, entry.born) <= 0) return;
    entry.born = stamp;
    const defaults = this._doc["_resolvedNodeDefs"].get(entry.type!)!;
    for (const key in entry.stamps) {
      if (compare(entry.stamps[key]!, stamp) >= 0) continue;
      delete entry.stamps[key];
      this._writeState(entry, key, defaults.defaultStrings[key]!);
    }
  }

  private _mergeState(entry: Entry, key: string, value: string, stamp: Stamp) {
    const current = entry.stamps[key];
    if (current && compare(stamp, current) <= 0) return;
    // The insert's own values share its stamp.
    /* v8 ignore next -- @preserve: a key the newer insert left at its default. */
    if (entry.born && compare(stamp, entry.born) < 0) return;
    entry.stamps[key] = stamp;
    if (entry.node) this._writeState(entry, key, value);
    else (entry.pending ??= {})[key] = value;
  }

  private _writeState(entry: Entry, key: string, value: string) {
    const node = entry.node!;
    const doc = this._doc;
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

  private _isAlive(id: string) {
    if (id === this._doc.root.id) return true;
    const entry = this._entries.get(id);
    return entry?.type !== undefined && !this._isDoomed(entry);
  }

  /**
   * A pending descendant dies while its pointer is still the one its deleter
   * saw and its parent is dead or doomed too: still under the deleted node.
   */
  private _isDoomed(entry: Entry): boolean {
    if (this._pending.size === 0) return false;
    // Concurrent moves can leave pending pointers in a cycle. Its nodes were
    // all under the deleted node when its deleter saw them: doomed. Most
    // walks end at the first node, which needs no set.
    let visited: Set<Entry> | undefined;
    for (let current = entry; ; ) {
      const pending = this._pending.get(current.id);
      if (pending?.life !== current.life || !current.at) return false;
      if (compare(current.at, pending.seen) > 0) return false;
      const parent = current.parent!;
      const parentEntry = this._entries.get(parent);
      // Gone, or never arrived (the root always has its entry).
      if (parentEntry?.type === undefined) return parent !== this._doc.root.id;
      (visited ??= new Set()).add(current);
      if (visited.has(parentEntry)) return true;
      current = parentEntry;
    }
  }

  /** Where the pointer of an entry takes it, before looking at cycles. */
  private _pointerTarget(entry: Entry): string | undefined {
    if (entry.parent === undefined) return undefined;
    if (this._isAlive(entry.parent)) return entry.parent;
    if (entry.back && this._isAlive(entry.back.parent))
      return entry.back.parent;
    return undefined;
  }

  private _target(entry: Entry): [string | undefined, string] {
    if (this._isDoomed(entry)) return [undefined, entry.pos];
    const cut = this._cuts.get(entry.id);
    if (cut) return [cut.parent, cut.pos];
    const parent = this._pointerTarget(entry);
    if (parent === undefined) return [undefined, entry.pos];
    if (parent === entry.parent) return [parent, entry.pos];
    return [parent, entry.back!.pos];
  }

  /** True if some cycle exists, found by walking up from the changed entries. */
  private _hasNewCycle() {
    const rootId = this._doc.root.id;
    for (const entry of this._dirty) {
      // Most walks reach the root in a few steps: the set that finds a
      // cycle is made only for a long one.
      let seen: Set<string> | undefined;
      for (let cur = entry.id, steps = 0; ; steps++) {
        if (steps > CYCLE_STEPS) {
          seen ??= new Set();
          if (seen.has(cur)) return true;
          seen.add(cur);
        }
        const at = this._entries.get(cur);
        const parent = at && this._pointerTarget(at);
        if (parent === undefined || parent === rootId) break;
        cur = parent;
      }
    }
    return false;
  }

  /** The cycle cut: a pure function of the labels. */
  private _resolveCuts() {
    const rootId = this._doc.root.id;
    const cuts = new Map<string, Back>();
    const stages = new Map<string, number>();
    const edge = new Map<string, string | undefined>();
    for (const entry of this._entries.values()) {
      if (entry.id !== rootId && entry.type !== undefined && entry.at) {
        edge.set(entry.id, this._pointerTarget(entry));
      }
    }
    const worst = (cycle: string[]) => {
      let best = cycle[0]!;
      for (const id of cycle) {
        const a = this._entries.get(id)!.at!;
        const b = this._entries.get(best)!.at!;
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
        const entry = this._entries.get(id)!;
        const stage = stages.get(id) ?? 0;
        let next = rootId;
        /* v8 ignore next 9 -- @preserve: a second cut of the same node, when
           its previous position closes another cycle. The lab fuzz reaches it. */
        if (
          stage === 0 &&
          entry.back &&
          this._isAlive(entry.back.parent) &&
          entry.back.parent !== id
        ) {
          next = entry.back.parent;
          stages.set(id, 1);
        } else {
          stages.set(id, 2);
        }
        edge.set(id, next);
        /* v8 ignore next -- @preserve: a cut node is always one that moved. */
        cuts.set(id, { parent: next, pos: entry.back?.pos ?? entry.pos });
      }
    }
    return cuts;
  }

  private _reconcile() {
    const rootId = this._doc.root.id;
    this._updateCuts();
    // Real removals first, so that a removed parent never receives children.
    for (const entry of this._dropped) this._remove(entry);
    this._dropped = [];

    // Placing an entry can change whether others are visible, and so where
    // their pointers lead, which can close or open a cycle: repeat.
    while (this._dirty.size > 0) {
      const order = this._topDown([...this._dirty], rootId);
      this._dirty.clear();
      for (const entry of order) {
        if (this._entries.get(entry.id) !== entry) continue;
        this._place(entry);
      }
      if (this._dirty.size > 0) this._updateCuts();
    }
  }

  private _updateCuts() {
    if (this._cuts.size === 0 && !this._hasNewCycle()) return;
    const previous = this._cuts;
    this._cuts = this._resolveCuts();
    for (const id of new Set([...previous.keys(), ...this._cuts.keys()])) {
      const entry = this._entries.get(id);
      if (entry) this._dirty.add(entry);
    }
  }

  private _remove(entry: Entry) {
    const node = entry.node;
    if (!node) return;
    const doc = this._doc;
    const attached = doc["_nodeMap"].get(node.id) === node;
    // `_unlink` does nothing for a hidden node that is not linked anywhere.
    if (attached) this._classicDelete(node);
    else this._unlink(node);
    entry.node = undefined;
  }

  /** Classic delete leaves stale prev/next/parent pointers on the node. */
  private _classicDelete(node: DocNode) {
    node.to(node).delete();
    this._clearLinks(node);
  }

  private _clearLinks(node: DocNode) {
    node["_set"]("parent", undefined);
    node["_set"]("prev", undefined);
    node["_set"]("next", undefined);
  }

  private _unlink(node: DocNode) {
    if (node.parent) detachRange(node, node);
    this._clearLinks(node);
  }

  private _topDown(entries: Entry[], rootId: string) {
    if (entries.length === 1) return entries;
    const depth = new Map<Entry, number>();
    const depthOf = (entry: Entry): number => {
      const known = depth.get(entry);
      if (known !== undefined) return known;
      depth.set(entry, 0);
      const [parent] = this._target(entry);
      const parentEntry =
        parent !== undefined && parent !== rootId
          ? this._entries.get(parent)
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

  private _place(entry: Entry) {
    const node = entry.node;
    if (!node) return;
    const alive = this._isAlive(entry.id);
    if (alive !== entry.alive) {
      entry.alive = alive;
      this._wake(entry);
    }
    const doc = this._doc;
    const map = doc["_nodeMap"];
    const [parentId, key] = this._target(entry);
    // A place that has not arrived yet places the node again when it does. Meanwhile it goes after the placed ones (see `_prevSibling`).
    if (parentId !== undefined) this._waitForPlace(key, entry);
    const away = parentId !== undefined && this._isAway(key, parentId);
    const parentEntry =
      parentId === undefined ? undefined : this._entries.get(parentId);
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
    if (unchanged && !this._forced.delete(entry)) {
      this._refreshWaiting(entry);
      return;
    }
    entry.key = key;
    entry.away = away;
    this._refreshWaiting(entry);
    const attachedNow = map.get(node.id) === node;
    const parentAttached =
      parent !== undefined && map.get(parent.id) === parent;

    if (parent === undefined) {
      // Limbo: invisible, but its labels stay until garbage collection.
      if (attachedNow) this._classicDelete(node);
      else if (node.parent) this._unlink(node);
      if (
        this._session === parseId(entry.id)[0] &&
        !this._garbage.has(entry.id)
      ) {
        this._garbage.set(entry.id, this._clock);
      }
      return;
    }
    if (attachedNow && parentAttached) {
      // Its new parent is still shown inside it, until the nodes between
      // them are placed: those go first, then this one again.
      if (this._defer(entry, node, parent)) return;
      const prev = this._prevSibling(parent, entry);
      if (prev) node.to(node).move(prev, "after");
      else node.to(node).move(parent, "prepend");
      return;
    }
    if (attachedNow && !parentAttached) this._classicDelete(node);
    else if (node.parent) this._unlink(node);
    // Under a hidden parent too: nothing outside the document is recorded.
    const prev = this._prevSibling(parent, entry);
    if (prev) doc["_insertRange"](prev, "after", [node]);
    else doc["_insertRange"](parent, "prepend", [node]);
  }

  private _defer(entry: Entry, node: DocNode, parent: DocNode) {
    const between: Entry[] = [];
    for (let up: DocNode | undefined = parent; up; up = up.parent) {
      if (up === node) {
        for (const each of between) this._dirty.add(each);
        this._dirty.add(entry);
        return true;
      }
      between.push(this._entries.get(up.id)!);
    }
    return false;
  }

  /**
   * Entries that point at this one may now be shown, or hidden. Its children
   * too: a child moved into a node that is now doomed falls back elsewhere.
   */
  private _wake(entry: Entry) {
    this._waiting.get(entry.id)?.forEach((waiter) => this._dirty.add(waiter));
    this._dirtyChildren(entry.node!);
  }

  private _watchedParents(entry: Entry) {
    const parents = new Set<string>();
    if (entry.parent !== undefined) parents.add(entry.parent);
    if (entry.back) parents.add(entry.back.parent);
    return parents;
  }

  /** An entry shown away from a missing parent must hear when it arrives. */
  private _refreshWaiting(entry: Entry) {
    // Most entries watch only their parent.
    if (!entry.back && entry.parent !== undefined) {
      this._rewait(entry.parent, entry);
      return;
    }
    for (const parent of this._watchedParents(entry))
      this._rewait(parent, entry);
  }

  private _rewait(parent: string, entry: Entry) {
    this._unwait(parent, entry);
    if (!this._isAlive(parent)) this._wait(parent, entry);
  }

  private _prevSibling(parent: DocNode, entry: Entry): DocNode | undefined {
    // A node placed again later, still away, is not one to go after.
    if (!entry.away)
      return this._fugue.findBefore(entry.key, (owner, place) => {
        const other = this._entries.get(owner);
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
      const other = this._entries.get(prev.id)!;
      if (!other.away || prev.id < entry.id) return prev;
    }
    return undefined;
  }

  /* ----------------------------------- repair ---------------------------------- */

  /**
   * Normalize listeners never run on a remote change. If it left something
   * they would repair, they repair it now, as a local change of its own.
   */
  private _repair() {
    const doc = this._doc;
    const listeners = doc["_normalizeListeners"];
    this._repairing = { lamport: this._clock };
    try {
      doc.forceCommit(
        () => {
          listeners.forEach((listener) => listener({ diff: doc["_diff"] }));
        },
        { skipUndo: true },
      );
    } finally {
      this._repairing = undefined;
    }
  }

  /* --------------------------- undo and aborts (classic) --------------------------- */

  /* v8 ignore next 8 -- @preserve: only an undo of a range move whose target
     ended inside the range, which the lab fuzz reaches. */
  private _isInside(target: DocNode, start: DocNode, end: DocNode) {
    for (let cur: DocNode | undefined = start; cur; cur = cur.next) {
      if (target === cur) return true;
      if (target.ancestors().find((a) => a === cur)) return true;
      if (cur === end) break;
    }
    return false;
  }

  private _resolveAlias(id: string) {
    let current = id;
    let alias = this._aliases.get(current);
    while (alias !== undefined) {
      current = alias;
      alias = this._aliases.get(current);
    }
    return current;
  }

  /** Makes an inverse apply reliable when anchors or ids changed meanwhile. */
  private _prepareClassic(operations: DraftOperations): DraftOperations {
    const doc = this._doc;
    const { root } = doc;
    const newId = this._options.undo === "newId";
    const fresh = new Map<string, string>();
    const name = (id: string) => {
      const known = fresh.get(id) ?? this._resolveAlias(id);
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
              this._deadLife(name(id)) >= 0 &&
              !doc.getNodeById(name(id))
            ) {
              const replacement = doc["_nodeIdGenerator"](doc);
              fresh.set(id, replacement);
              this._aliases.set(this._resolveAlias(id), replacement);
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
          /* v8 ignore next -- @preserve: see `_isInside`. */
          if (this._isInside(target, start, end)) return [];
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
  private _toJSON(json: JsonDoc): JsonDoc {
    this._rootEntry();
    const rootId = this._doc.root.id;
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
        const entry = this._entries.get(child.id)!;
        const [clock, session] = entry.at!;
        sessionColumn.push(names.index(session));
        lamportColumn.pushSigned(clock - lamport);
        lamport = clock;
        // A place with the node's id is not written.
        placeColumn.push(placeKind(entry, child.id, places));
        const extra = this._extra(entry, names, false);
        if (extra) extras.push(index, extra);
        index++;
        walk(child);
      }
    };
    walk(this._doc.root);
    const hidden: Entry[] = [];
    for (const entry of this._entries.values()) {
      if (entry.id === rootId) continue;
      const node = entry.node;
      // Shown: linked under a node of the document.
      if (node && this._doc["_nodeMap"].get(node.id) === node) continue;
      hidden.push(entry);
    }
    hidden.sort((a, b) => Number(a.id > b.id) - Number(a.id < b.id));
    const limbo = hidden.map((entry): Json[] => {
      const [clock, session] = entry.at ?? ZERO;
      // A hidden label always says where its pointer is.
      const extra = this._extra(entry, names, true)!;
      const label: Json[] = [entry.pos, clock, names.index(session), extra];
      const state = entry.node ? entry.node["_stateToJson"]() : entry.pending;
      return [names.write(entry.id), entry.type ?? 0, label, state ?? 0];
    });
    const aliases: Json[] = [];
    for (const [old, renamed] of this._aliases)
      aliases.push(names.write(old), names.write(renamed));
    const rootStamps: Json[] = [];
    const root = this._entries.get(rootId)!;
    for (const key in root.stamps) {
      const [clock, session] = root.stamps[key]!;
      rootStamps.push(key, clock, names.index(session));
    }
    const pending: Json[] = [];
    for (const [id, { life, seen, own }] of [...this._pending].sort(
      (a, b) => Number(a[0] > b[0]) - Number(a[0] < b[0]),
    ))
      pending.push(names.write(id), life, seen[0], names.index(seen[1]), +own);
    const deleted: Json[] = [];
    this._deleted.forEach((session, runs) =>
      deleted.push([names.index(session), ...runs]),
    );
    const stored: Json[] = [
      this._clock,
      joinColumns([sessionColumn, lamportColumn, placeColumn]),
      places,
      extras,
      deleted,
      limbo,
      aliases,
      rootStamps,
      pending,
      this._fugue.toJSON(
        (list) => childIds(this._doc, list),
        (owner, place) => this._entries.get(owner)?.key === place,
        sessions,
      ),
    ];
    // The document's table again, with the labels' sessions after its own,
    // and its first column, how much each shares with the one before.
    const columns = splitColumns(json[7] ?? "").map((column) => ({
      encode: () => column,
    }));
    json[3] = frontCode(
      sessions.table,
      rootId,
      (columns[0] = new ColumnWriter()),
    );
    json[7] = joinColumns(columns);
    return withCrdt(json, stored);
  }

  /** What a label has that its columns leave out, or nothing. */
  private _extra(
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

  /** Sets what `label` stores on `entry` (see `_extra`). */
  private _restoreLabel(
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
      this._offTree = true;
      entry.parent = extra.u === 0 ? undefined : names.read(extra.u);
      entry.pos = text(extra.q);
      // Without a pointer it has no stamp either: an insert without one (see
      // `_birthStamp`) still applies.
      if (extra.u === 0) entry.at = undefined;
    }
    const stamps = list(extra.s);
    for (let at = 0; at < stamps.length; at += 3)
      entry.stamps[text(stamps[at])] = stamp(stamps[at + 1], stamps[at + 2]);
  }

  /** Rebuilds the labels once `Doc.fromJSON` built the tree. */
  load(json: JsonDoc | JsonTree) {
    const doc = this._doc;
    const root = this._rootEntry();
    root.node = doc.root;
    const fugue = this._newFugue();
    this._fugue = fugue;
    const stored = isTree(json) ? undefined : json[9];
    if (isTree(json) || !isList(stored)) {
      // A document without labels: deterministic labels, same on every replica.
      const walk = (node: DocNode) => {
        for (let child = node.first; child; child = child.next) {
          const entry = this._newEntry(child.id, 0, child.type);
          entry.node = child;
          entry.parent = node.id;
          // The same places on every replica that loads it.
          fugue.create(child.id, child.id, node.id, child.prev?.id);
          entry.pos = entry.key = child.id;
          entry.at = ZERO;
          for (const key in child["_state"]) entry.stamps[key] = ZERO;
          this._entries.set(child.id, entry);
          walk(child);
        }
      };
      walk(doc.root);
      return;
    }
    const labels = new StoredLabels(stored, storedSessions(json, doc.root.id));
    this._clock = labels.clock;
    labels.places(fugue, doc);
    labels.deleted((session, from, to, life) =>
      this._deleted.add(session, from, to, life),
    );
    labels.aliases((old, renamed) => this._aliases.set(old, renamed));
    labels.visible(doc.root, (child, parent, label) => {
      const entry = this._newEntry(child.id, 0, child.type);
      entry.node = child;
      entry.parent = parent.id;
      this._restoreLabel(entry, label, labels, child["_state"]);
      // A cut keeps the view where it was shown and its pointer elsewhere.
      entry.key = entry.pos;
      entry.away = !!label.away;
      // Shown before its place arrived, it waits for it again.
      if (entry.away) this._waitForPlace(entry.key, entry);
      this._entries.set(child.id, entry);
    });
    labels.rootStamps((key, stamp) => (root.stamps[key] = stamp));
    labels.limbo((id, type, label, state) => {
      this._offTree = true;
      const entry = this._newEntry(id, 0, type);
      this._restoreLabel(entry, label, labels, state);
      this._entries.set(id, entry);
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
      this._mergePending(id, life, seen);
      if (own) {
        this._pending.get(id)!.own = true;
        this._garbage.set(id, this._clock);
      }
    });
    this._rebuildAfterHydrate();
  }

  private _rebuildAfterHydrate() {
    // Every node is shown where it points, as one that never moved: there is
    // no cycle to cut and nothing to link.
    if (!this._offTree) return;
    // Limbo nodes are linked to the parents they already point to, and the
    // cycle cut is recomputed. Both are pure functions of the labels.
    const rootId = this._doc.root.id;
    for (const entry of this._entries.values()) {
      if (entry.id === rootId || !entry.node) continue;
      if (!entry.node.parent) this._dirty.add(entry);
    }
    this._cuts = this._resolveCuts();
    for (const entry of this._entries.values()) {
      if (entry.node && entry.id !== rootId) {
        const [, key] = this._target(entry);
        entry.key = key;
        const shownIn = entry.node.parent;
        if (shownIn) entry.away = this._isAway(key, shownIn.id);
        if (entry.away) this._waitForPlace(key, entry);
        // A node shown away from a dead parent goes back when it revives.
        this._refreshWaiting(entry);
      }
    }
    // Dirty limbo entries re-link under their (possibly invisible) parents.
    const order = this._topDown([...this._dirty], rootId);
    for (const entry of order) this._place(entry);
    this._dirty.clear();
  }

  private _mergeSnapshot(stored: Json | undefined) {
    if (!isJsonDoc(stored) || !isList(stored[9])) return;
    // A snapshot is one of this document, which has its id.
    const id = this._doc.root.id;
    const labels = new StoredLabels(stored[9], storedSessions(stored, id));
    this._clock = Math.max(this._clock, labels.clock);
    labels.deleted((session, from, to, life) =>
      this._mergeDelete([session, from, to, life]),
    );
    const ingest = (
      id: string,
      type: string | undefined,
      parent: string | undefined,
      label: Label,
      state: Record<string, string>,
    ) => {
      const scratch = this._newEntry(id, 0, type);
      scratch.parent = parent;
      this._restoreLabel(scratch, label, labels, state);
      const entry = this._ensure(id, scratch.life);
      if (!entry) return;
      const wasTyped = entry.type !== undefined;
      if (type !== undefined) entry.type = type;
      if (scratch.parent !== undefined) {
        this._mergePointer(
          entry,
          scratch.parent,
          scratch.pos,
          scratch.at!,
          scratch.back,
        );
      }
      if (!wasTyped && type !== undefined) this._onTyped(entry);
      // As its insert would: state written before this life began is reset.
      if (type !== undefined) this._mergeBirth(entry, scratch.born!);
      for (const key in state) {
        this._mergeState(entry, key, state[key]!, scratch.stamps[key]!);
      }
      for (const key in scratch.stamps) {
        if (key in state) continue;
        // Only a typed node leaves a written value out: its key's default.
        const defaults = this._doc["_resolvedNodeDefs"].get(entry.type!)!;
        const value = defaults.defaultStrings[key]!;
        this._mergeState(entry, key, value, scratch.stamps[key]!);
      }
    };
    // The stored tree, read by a document of the same node types.
    const doc = this._doc;
    const copy = Doc.fromJSON(
      {
        id,
        type: doc.root.type,
        extensions: [{ nodes: [...doc["_nodeDefs"]] }],
        nodeIdGenerator: doc["_idGen"],
      },
      stored,
    );
    labels.places(this._fugue, copy);
    labels.visible(copy.root, (child, parent, label) =>
      ingest(child.id, child.type, parent.id, label, child["_stateToJson"]()),
    );
    labels.limbo((id, type, label, state) =>
      ingest(id, type, undefined, label, state),
    );
    labels.pending((id, life, seen) => this._mergePending(id, life, seen));
  }
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

const num = (value: Json | undefined) => Number(value);

const list = (value: Json | undefined): readonly Json[] =>
  isList(value) ? value : [];

const isRecord = (
  value: Json | undefined,
): value is { readonly [key: string]: Json | undefined } =>
  typeof value === "object" && value !== null && !isList(value);

/** A stored state: each value as a JSON string. A label without one has `0`. */
function stateOf(value: Json | undefined) {
  const state: Record<string, string> = {};
  if (isRecord(value)) for (const key in value) state[key] = text(value[key]);
  return state;
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
 * The labels of a stored document, `json[9]`:
 *
 * `[clock, columns, places, extras, deleted, limbo, aliases, rootStamps,
 * pending, lists]`. Node ids are written by the sessions of the document's
 * table (see `writeId`), and so are stamps, `[clock, session]`.
 *
 * - `columns`, one number per visible node in the order of the stored tree:
 *   the session of its stamp, its clock as the difference from the previous
 *   node's, and how its place is stored (see `placeKind`). `places` lists
 *   the places that are not the node's id.
 * - `extras`: `[index, extra, …]`, what the labels of those nodes have that
 *   the columns leave out (see `_extra`).
 * - `deleted`: `[[session, from, to, life, …], …]`.
 * - `limbo`: `[[id, type | 0, [key, clock, session, extra?], state | 0], …]`,
 *   the labels of nodes not shown.
 * - `aliases`: `[old, new, …]`; `rootStamps`: `[key, clock, session, …]`;
 *   `pending`: `[id, life, clock, session, own, …]`.
 * - `lists`: the places of every list (see `FugueSiblings.toJSON`).
 */
class StoredLabels {
  readonly clock: number;

  constructor(
    private readonly _stored: readonly Json[],
    private readonly _sessions: readonly string[],
  ) {
    this.clock = num(_stored[0]);
  }

  /** A session `sessionWriter` wrote. */
  session(index: Json | undefined): string {
    return this._sessions[num(index) - 1] ?? "";
  }

  /** A node id `sessionWriter` wrote. */
  read(written: Json | undefined): string {
    return readId(text(written), (index) => this.session(index));
  }

  /** The stored places of the stored tree `doc`. */
  places(fugue: FugueSiblings, doc: Doc) {
    fugue.load(this._stored[9], (list) => childIds(doc, list), this._sessions);
  }

  private _label(value: Json | undefined): Label {
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
    const stored = this._stored;
    const [sessions, clocks, kinds] = splitColumns(text(stored[1]), 3).map(
      (column) => new ColumnReader(column),
    );
    const places = list(stored[2]).map(text);
    const extras = new Map<number, Json | undefined>();
    const extraList = list(stored[3]);
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
    for (const group of list(this._stored[4])) {
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
    for (const item of list(this._stored[5])) {
      const [id, type, label, state] = list(item);
      visit(
        this.read(id),
        typeof type === "string" ? type : undefined,
        this._label(label),
        stateOf(state),
      );
    }
  }

  aliases(visit: (old: string, renamed: string) => void) {
    const aliases = list(this._stored[6]);
    for (let at = 0; at < aliases.length; at += 2)
      visit(this.read(aliases[at]), this.read(aliases[at + 1]));
  }

  rootStamps(visit: (key: string, stamp: Stamp) => void) {
    const stamps = list(this._stored[7]);
    for (let at = 0; at < stamps.length; at += 3)
      visit(text(stamps[at]), [
        num(stamps[at + 1]),
        this.session(stamps[at + 2]),
      ]);
  }

  pending(
    visit: (id: string, life: number, seen: Stamp, own: boolean) => void,
  ) {
    const pending = list(this._stored[8]);
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
  Array.isArray(json) &&
  json[0] === FORMAT &&
  typeof json[1] === "string" &&
  typeof json[2] === "object";

/**
 * The labels engine for `DocConfig.crdt`: each node carries a label (its
 * parent, its position among its siblings and a stamp per field), and the
 * newest stamp wins. A change that arrives late costs the same as one on time.
 */
export const labelsEngine =
  (options?: CrdtOptions): CrdtEngineFactory =>
  (doc: Doc) =>
    new Engine(doc, options);

/**
 * A whole stored document as a batch: a replica that lost what it sent (a
 * crash) sends this instead. Merging it twice changes nothing.
 */
export const labelsSnapshot = (json: JsonDoc): Operations => {
  const stored = json.filter((element) => element !== undefined);
  return ["", [SNAPSHOT, stored]];
};
