import type { Doc } from "../main.js";
import type { Json } from "../types.js";
import { isList, kidIndex } from "../utils.js";
import { list, text } from "../wire.js";
import {
  ColumnReader,
  ColumnWriter,
  joinColumns,
  joinId,
  splitColumns,
  type SessionTable,
} from "../columns.js";

/**
 * The order of siblings of the labels engine: FugueMax, the list algorithm
 * of the text (`text/store.ts`), over places instead of letters.
 *
 * - A place is where a node was inserted or moved to, with a stable id: the
 *   node's id for its first insert, a fresh one for anything else. A move
 *   makes a new place and the old one stays as a tombstone, as a deleted
 *   letter does (Loro's `MovableList` does the same).
 * - Each parent has a list of places, which starts at an implicit root. The
 *   order of a list is a pure function of its places: a Fugue tree (parent,
 *   side, and right origin for the FugueMax rule), so it does not depend on
 *   the order in which they arrive.
 * - Which place shows each node is the engine's business (the newest
 *   pointer). The places never move.
 */

/** A place as it travels: what makes it, and whose place it is. */
export type Place = {
  readonly id: string;
  /** The node it places. */
  readonly owner: string;
  /** The parent whose children it orders. */
  readonly list: string;
  /** Its parent in the Fugue tree; `undefined` for the list's root. */
  readonly parent: string | undefined;
  readonly side: 0 | 1;
  /** Its right origin (only right children use it). */
  readonly rs: string | undefined;
};

class Element {
  /** Its kids of each side, sorted: one alone, without an array. */
  left: Kids = undefined;
  right: Kids = undefined;
  prev: Element | undefined = undefined;
  next: Element | undefined = undefined;
  seq = 0;

  constructor(
    readonly id: string,
    readonly owner: string,
    readonly list: List,
    public parent: Element | undefined,
    public side: 0 | 1,
    public rs: Element | undefined,
  ) {}
}

class List {
  readonly root: Element;
  dirty = true;
  constructor(readonly id: string) {
    this.root = new Element("", "", this, undefined, 1, undefined);
  }
}

/** The places of every parent of a document. */
export class FugueSiblings {
  readonly #elements = new Map<string, Element>();
  #lists: Map<string, List> | undefined;
  /** Places whose parent or right origin has not arrived, by id. */
  #pending: Map<string, Place> | undefined;
  /** Ids of pending places, by the id each waits for. */
  #waiting: Map<string, string[]> | undefined;
  /** Lists `load` read, built when something first asks for a place. */
  #deferred: [string, Stored][] = [];

  /** Called with the id of each place once it is in its list. */
  readonly #onReady: (id: string) => void;

  constructor(onReady: (id: string) => void) {
    this.#onReady = onReady;
  }

  has(id: string): boolean {
    this.#ready();
    return this.#elements.has(id);
  }

  /** Whether it has no place, nor one waiting or still stored. */
  isEmpty(): boolean {
    return (
      this.#elements.size +
        this.#deferred.length +
        (this.#pending?.size ?? 0) ===
      0
    );
  }

  /** Builds the lists `load` deferred. */
  #ready() {
    if (this.#deferred.length === 0) return;
    const deferred = this.#deferred;
    this.#deferred = [];
    for (const [id, read] of deferred) this.#build(id, read);
  }

  /** The parent whose children place `id` orders, once it is in its list. */
  listOf(id: string): string | undefined {
    this.#ready();
    return this.#elements.get(id)?.list.id;
  }

  #list(id: string) {
    const lists = (this.#lists ??= new Map<string, List>());
    let list = lists.get(id);
    if (!list) lists.set(id, (list = new List(id)));
    return list;
  }

  /**
   * A new place right after place `left` (or at the start) of list `list`:
   * the right child of `left` if it has none, else the left child of what
   * follows it.
   */
  create(id: string, owner: string, list: string, left: string | undefined) {
    this.#ready();
    const listOf = this.#list(list);
    const after = left === undefined ? listOf.root : this.#elements.get(left)!;
    const element = after.right
      ? new Element(id, owner, listOf, after.next, 0, undefined)
      : new Element(id, owner, listOf, after, 1, after.next);
    this.#elements.set(id, element);
    this.#place(element);
    listOf.dirty = true;
    this.#onReady(id);
  }

  /** Adds a place. Adding one again changes nothing. */
  add(place: Place): void {
    this.#ready();
    if (this.#elements.has(place.id) || this.#pending?.has(place.id)) return;
    if (!this.#integrate(place) || !this.#waiting?.size) return;
    // Places that waited for it, and those that waited for them.
    const ready = [place.id];
    while (ready.length > 0) {
      const id = ready.pop()!;
      const waiting = this.#waiting.get(id);
      if (!waiting) continue;
      this.#waiting.delete(id);
      for (const pendingId of waiting) {
        const pending = this.#pending!.get(pendingId)!;
        this.#pending!.delete(pendingId);
        if (this.#integrate(pending)) ready.push(pendingId);
      }
    }
  }

  /** Puts `place` in its list, or keeps it until what it needs arrives. */
  #integrate(place: Place) {
    const parent =
      place.parent === undefined
        ? this.#list(place.list).root
        : this.#elements.get(place.parent);
    const rs =
      place.rs === undefined ? undefined : this.#elements.get(place.rs);
    if (!parent || (place.rs !== undefined && !rs)) {
      const missing = parent ? place.rs! : place.parent!;
      (this.#pending ??= new Map<string, Place>()).set(place.id, place);
      const waits = (this.#waiting ??= new Map<string, string[]>());
      const waiting = waits.get(missing);
      if (waiting) waiting.push(place.id);
      else waits.set(missing, [place.id]);
      return false;
    }
    // The list is its parent's: a place never leaves the list it was made in.
    const list = parent.list;
    // The list's root has nothing before it: only right children.
    const side = parent === list.root ? 1 : place.side;
    const element = new Element(place.id, place.owner, list, parent, side, rs);
    this.#elements.set(place.id, element);
    this.#place(element);
    list.dirty = true;
    this.#onReady(place.id);
    return true;
  }

  /**
   * How place `id` travels next to its node, after the place `previous` that
   * the same batch wrote before it; `undefined` if it is not in its list here.
   *
   * `[origin, right]`: `origin` is `0` for the list's root, an id for its
   * right child, `[id]` for its left child, and `""` for the right child of
   * `previous` with the same right origin; `right` is the right origin, or
   * `0`.
   */
  writePlace(
    id: string,
    previous: string | undefined,
    write: (id: string) => Json,
  ): [Json, Json] | undefined {
    this.#ready();
    const element = this.#elements.get(id);
    if (!element) return undefined;
    const parent = element.parent!;
    if (element.side === 0) return [[write(parent.id)], 0];
    if (
      previous !== undefined &&
      parent === this.#elements.get(previous) &&
      element.rs === parent.rs
    )
      return ["", 0];
    return [
      parent === element.list.root ? 0 : write(parent.id),
      element.rs ? write(element.rs.id) : 0,
    ];
  }

  // ----- FugueMax --------------------------------------------------------

  #seq(element: Element | undefined) {
    if (!element) return Infinity;
    const list = element.list;
    if (list.dirty) {
      let seq = 0;
      for (let at: Element | undefined = list.root; at; at = at.next)
        at.seq = seq++;
      list.dirty = false;
    }
    return element.seq;
  }

  /**
   * Among the right children of one place: the reverse order of their right
   * origins, then ids.
   */
  #rightBefore(a: Element, b: Element) {
    // Different right origins are at different positions (none is last).
    if (a.rs !== b.rs) return this.#seq(a.rs) > this.#seq(b.rs);
    return a.id < b.id;
  }

  #place(element: Element) {
    const parent = element.parent!;
    const kids = element.side === 1 ? parent.right : parent.left;
    // Mostly the first kid of its side, or the second.
    if (!kids) {
      if (element.side === 1) linkAfter(parent, element);
      else linkBefore(parent, element);
      setKids(parent, element.side, element);
      return;
    }
    const list = Array.isArray(kids) ? kids : [kids];
    let index: number;
    if (element.side === 1) {
      index = kidIndex(list, (kid) => this.#rightBefore(element, kid));
      if (index < list.length) linkBefore(leftmost(list[index]!), element);
      else linkAfter(rightmost(parent), element);
    } else {
      index = kidIndex(list, (kid) => element.id < kid.id);
      linkBefore(
        index < list.length ? leftmost(list[index]!) : parent,
        element,
      );
    }
    list.splice(index, 0, element);
    setKids(parent, element.side, list);
  }

  // ----- reading ---------------------------------------------------------

  /**
   * The first value `pick` gives for the places before place `id`, from the
   * nearest one back. `pick` gets the owner and the id of each place.
   */
  findBefore<T>(
    id: string,
    pick: (owner: string, place: string) => T | undefined,
  ): T | undefined {
    this.#ready();
    const element = this.#elements.get(id)!;
    const root = element.list.root;
    for (let at = element.prev; at && at !== root; at = at.prev) {
      const found = pick(at.owner, at.id);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  // ----- wire --------------------------------------------------------------

  /**
   * A place that waits, as `writePlace` writes one with nothing before it.
   * The root of a list is always there: it has a parent.
   */
  static #writePending(place: Place): [Json, Json] {
    const parent = place.parent!;
    return place.side === 0 ? [[parent], 0] : [parent, place.rs ?? 0];
  }

  /** The place `writePlace` wrote (an `origin` left out is `""`). */
  static read(
    origin: Json | undefined,
    right: Json | undefined,
    id: string,
    owner: string,
    list: string,
    previous: Place | undefined,
    read: (written: Json | undefined) => string,
  ): Place {
    if (isList(origin))
      return {
        id,
        owner,
        list,
        parent: read(origin[0]),
        side: 0,
        rs: undefined,
      };
    if (origin === undefined || origin === "")
      return {
        id,
        owner,
        list,
        parent: previous?.id,
        side: 1,
        rs: previous?.rs,
      };
    return {
      id,
      owner,
      list,
      parent: origin === 0 ? undefined : read(origin),
      side: 1,
      rs: right === undefined || right === 0 ? undefined : read(right),
    };
  }

  // ----- storage -----------------------------------------------------------

  /**
   * `[columns, pending?]`, or `0` without places. Each list is written in
   * order, each place with only what its position does not imply (see
   * `KIND`). A place that shows the next child its parent has in the stored
   * tree takes its owner from there, and its id too when it is the owner's.
   * Other ids are a session of the document's table, `sessions`, and a clock
   * (see `SessionTable`).
   * `pending`: the places still waiting, `[id, owner, list, origin, right]`
   * as they travel (see `writePlace`).
   *
   * `children` gives the ids of the children of a list's parent in the
   * stored tree, and `shows` whether a node is shown at a place.
   */
  toJSON(
    children: (list: string) => readonly string[] | undefined,
    shows: (owner: string, place: string) => boolean,
    sessions: SessionTable,
  ): Json {
    this.#ready();
    // A document without places writes nothing for them.
    if (this.#elements.size + (this.#pending?.size ?? 0) === 0) return 0;
    const columns = Array.from({ length: COLUMNS }, () => new ColumnWriter());
    const column = (field: number) => columns[field]!;
    let lastClock = 0;
    const writeId = (
      id: string,
      sessionColumn: number,
      clockColumn: number,
    ) => {
      column(sessionColumn).push(sessions.node(id));
      column(clockColumn).pushSigned(sessions.clock - lastClock);
      lastClock = sessions.clock;
    };
    // A list is made with its first place: none is empty.
    for (const list of this.#lists?.values() ?? []) {
      this.#seq(list.root);
      const listClock = lastClock;
      writeId(list.id, COLUMN_LIST_SESSION, COLUMN_LIST_CLOCK);
      lastClock = listClock;
      let count = 0;
      for (let at: Element | undefined = list.root.next; at; at = at.next)
        count++;
      column(COLUMN_COUNT).push(count);
      const kids = children(list.id) ?? NO_IDS;
      let kid = 0;
      for (let at: Element | undefined = list.root.next; at; at = at.next) {
        const prev = at.prev!;
        const parent = at.parent!;
        let kind: number;
        if (at.side === 1 && parent === prev) {
          if (at.rs === prev.rs) kind = KIND_CHAIN;
          else {
            kind = KIND_AFTER;
            column(COLUMN_RS).pushSigned(rsOffset(at));
          }
        } else if (at.side === 0 && parent === at.next) kind = KIND_BEFORE;
        else if (
          parent === prev.parent &&
          at.side === prev.side &&
          (at.side === 0 || at.rs === prev.rs)
        )
          kind = KIND_SIBLING;
        else {
          kind = at.side === 1 ? KIND_RIGHT : KIND_LEFT;
          column(COLUMN_PARENT).pushSigned(parent.seq - at.seq);
          if (at.side === 1) column(COLUMN_RS).pushSigned(rsOffset(at));
        }
        const shown = kids[kid] === at.owner && shows(at.owner, at.id) ? 1 : 0;
        kid += shown;
        const other = at.owner === at.id ? 0 : 2;
        column(COLUMN_CODE).push(kind * 4 + other + shown);
        if (shown && !other) continue;
        writeId(at.id, COLUMN_SESSION, COLUMN_CLOCK);
        if (shown || !other) continue;
        const clock = lastClock;
        writeId(at.owner, COLUMN_OWNER_SESSION, COLUMN_OWNER_CLOCK);
        lastClock = clock;
      }
    }
    const pending: Json[] = [];
    for (const place of this.#pending?.values() ?? []) {
      const [origin, right] = FugueSiblings.#writePending(place);
      pending.push([place.id, place.owner, place.list, origin, right]);
    }
    const stored: Json[] = [joinColumns(columns)];
    if (pending.length > 0) stored.push(pending);
    return stored;
  }

  /**
   * Adds the places `toJSON` stored (`children` as there, `names` the
   * sessions of the document's table). A list this registry does not have
   * yet is built as stored, without searching where each place goes.
   */
  load(
    json: Json | undefined,
    children: (list: string) => readonly string[] | undefined,
    names: readonly string[],
  ): void {
    this.#ready();
    const [joined, pending] = list(json);
    const readers = splitColumns(text(joined), COLUMNS).map(
      (column) => new ColumnReader(column),
    );
    const column = (field: number) => readers[field]!;
    let lastClock = 0;
    const readId = (sessionColumn: number, clockColumn: number) => {
      const session = names[column(sessionColumn).next()]!;
      lastClock += column(clockColumn).nextSigned();
      return joinId(session, lastClock);
    };
    const lists = column(COLUMN_COUNT);
    // Every list has places: the counts are never 0, and none is left out.
    while (!lists.done) {
      const listClock = lastClock;
      const listId = readId(COLUMN_LIST_SESSION, COLUMN_LIST_CLOCK);
      lastClock = listClock;
      const count = lists.next();
      const kids = children(listId) ?? NO_IDS;
      let kid = 0;
      // Each place by its position (from 1; 0 is the root), in columns.
      const read: Stored = {
        ids: [],
        owners: undefined,
        sides: new Uint8Array(count + 1),
        parents: new Int32Array(count + 1),
        rss: new Int32Array(count + 1),
      };
      const { ids, sides, parents, rss } = read;
      for (let seq = 1; seq <= count; seq++) {
        const code = column(COLUMN_CODE).next();
        const kind = code >> 2;
        let parent = seq - 1;
        let side = kind === KIND_BEFORE || kind === KIND_LEFT ? 0 : 1;
        // Right origins are made positions in the list: those that come from
        // the place before already are.
        let rs = 0;
        if (kind === KIND_CHAIN) rs = rss[seq - 1]!;
        else if (kind === KIND_AFTER) rs = column(COLUMN_RS).nextSigned();
        else if (kind === KIND_BEFORE) parent = seq + 1;
        else if (kind === KIND_SIBLING) {
          parent = parents[seq - 1]!;
          side = sides[seq - 1]!;
          rs = rss[seq - 1]!;
        } else {
          // `RIGHT` or `LEFT`.
          parent = seq + column(COLUMN_PARENT).nextSigned();
          if (kind === KIND_RIGHT) rs = column(COLUMN_RS).nextSigned();
        }
        if (rs !== 0 && (kind === KIND_AFTER || kind === KIND_RIGHT)) rs += seq;
        const shown = code & 1;
        const other = code & 2;
        const owner = shown ? kids[kid++]! : "";
        const id =
          shown && !other ? owner : readId(COLUMN_SESSION, COLUMN_CLOCK);
        let ownerId = shown || !other ? owner || id : "";
        if (!ownerId) {
          const clock = lastClock;
          ownerId = readId(COLUMN_OWNER_SESSION, COLUMN_OWNER_CLOCK);
          lastClock = clock;
        }
        // Most places are their node's first: their owners are their ids.
        if (read.owners || ownerId !== id)
          (read.owners ??= [...ids]).push(ownerId);
        ids.push(id);
        sides[seq] = side;
        parents[seq] = parent;
        rss[seq] = rs;
      }
      // A list new here is built as stored, when it is first needed: a
      // document can load and be read without it.
      if (this.#lists?.has(listId) || this.#pending?.size)
        this.#addStored(listId, read);
      else this.#deferred.push([listId, read]);
    }
    for (const row of list(pending)) {
      const [id, owner, parent, origin, right] = list(row);
      this.add(
        FugueSiblings.read(
          origin,
          right,
          text(id),
          text(owner),
          text(parent),
          undefined,
          text,
        ),
      );
    }
  }

  /** A stored list, place by place, as places that travel. */
  #addStored(list: string, read: Stored) {
    const { ids, owners = ids, sides, parents, rss } = read;
    const idAt = (seq: number) => (seq === 0 ? undefined : ids[seq - 1]!);
    ids.forEach((id, index) => {
      const seq = index + 1;
      this.add({
        id,
        owner: owners[index]!,
        list,
        parent: idAt(parents[seq]!),
        side: sides[seq] === 0 ? 0 : 1,
        rs: idAt(rss[seq]!),
      });
    });
  }

  /** A new list, linked in its stored order: kids are met in their order. */
  #build(id: string, read: Stored) {
    const { ids, owners = ids, sides, parents, rss } = read;
    const list = this.#list(id);
    const elements: Element[] = [list.root];
    ids.forEach((placeId, index) => {
      const side = sides[index + 1] === 0 ? 0 : 1;
      const element = new Element(
        placeId,
        owners[index]!,
        list,
        undefined,
        side,
        undefined,
      );
      this.#elements.set(placeId, element);
      elements.push(element);
    });
    let prev = list.root;
    for (let seq = 1; seq < elements.length; seq++) {
      const element = elements[seq]!;
      const parent = elements[parents[seq]!]!;
      const rs = rss[seq]!;
      element.parent = parent;
      element.rs = rs === 0 ? undefined : elements[rs];
      // Kids are met in their order: each goes last.
      const kids = element.side === 1 ? parent.right : parent.left;
      setKids(
        parent,
        element.side,
        !kids
          ? element
          : Array.isArray(kids)
            ? (kids.push(element), kids)
            : [kids, element],
      );
      element.prev = prev;
      prev.next = element;
      prev = element;
    }
    for (const placeId of ids) this.#onReady(placeId);
  }
}

/**
 * The places of a list as `load` reads them: by position from 1, each
 * parent and right origin by its position (0 is the root, or none).
 */
type Stored = {
  ids: string[];
  /** Left out while every owner is its place's id. */
  owners: string[] | undefined;
  sides: Uint8Array;
  parents: Int32Array;
  rss: Int32Array;
};

const NO_IDS: readonly string[] = [];

function linkAfter(target: Element, element: Element) {
  const next = target.next;
  element.prev = target;
  element.next = next;
  target.next = element;
  if (next) next.prev = element;
}

/** How a stored place relates to the one before it in its list. */
/** Right child of the place before, with the same right origin. */
const KIND_CHAIN = 0;
/** Right child of the place before, its right origin in `RS`. */
const KIND_AFTER = 1;
/** Left child of the place after. */
const KIND_BEFORE = 2;
/** Right child of the place in `PARENT`, its right origin in `RS`. */
const KIND_RIGHT = 3;
/** Left child of the place in `PARENT`. */
const KIND_LEFT = 4;
/** Same parent, side and right origin as the place before. */
const KIND_SIBLING = 5;

const COLUMN_LIST_SESSION = 0;
const COLUMN_LIST_CLOCK = 1;
const COLUMN_COUNT = 2;
const COLUMN_CODE = 3;
const COLUMN_SESSION = 4;
const COLUMN_CLOCK = 5;
const COLUMN_PARENT = 6;
const COLUMN_RS = 7;
const COLUMN_OWNER_SESSION = 8;
const COLUMN_OWNER_CLOCK = 9;
const COLUMNS = 10;

/** Where a place's right origin is, from it (0 for none). */
const rsOffset = (element: Element) =>
  element.rs ? element.rs.seq - element.seq : 0;

/** The kids of one side of a place: none, one, or several in order. */
type Kids = Element | Element[] | undefined;

/**
 * For `toJSON` and `load`: the ids of the children of node `id`, in order, if
 * the document shows it.
 */
export function childIds(doc: Doc, id: string): string[] | undefined {
  const node = id === doc.root.id ? doc.root : doc["_nodeMap"].get(id);
  if (!node) return undefined;
  const ids: string[] = [];
  for (let child = node.first; child; child = child.next) ids.push(child.id);
  return ids;
}

function leftmost(element: Element) {
  let at = element;
  for (let kids = at.left; kids; kids = at.left)
    at = Array.isArray(kids) ? kids[0]! : kids;
  return at;
}

function rightmost(element: Element) {
  let at = element;
  for (let kids = at.right; kids; kids = at.right)
    at = Array.isArray(kids) ? kids.at(-1)! : kids;
  return at;
}

function linkBefore(target: Element, element: Element) {
  const prev = target.prev!;
  element.prev = prev;
  element.next = target;
  prev.next = element;
  target.prev = element;
}

function setKids(element: Element, side: 0 | 1, kids: Kids) {
  if (side === 1) element.right = kids;
  else element.left = kids;
}
