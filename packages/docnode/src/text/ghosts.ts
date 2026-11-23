import type { Json } from "../types.js";
import { SessionRuns } from "./common.js";

/**
 * Where the deleted letters of Base's text were (see `BaseText`): a ghost is
 * a range of deleted ids of one session and the element right before them,
 * its anchor (a live letter, or the start of a node's text), and what of
 * their state a letter typed next to them inherits. No text nor origins.
 *
 * - An insert whose neighbours are both deleted goes right after the anchor
 *   of one of them, where they were, instead of being lost.
 * - When an anchor is deleted, its ghosts move to the anchor of the deleted
 *   letter: every replica does it in the server's order, so anchors are
 *   always live and ghosts deleted one after the other become one.
 * - An id that is a ghost was applied: an insert of it again changes nothing.
 * - A letter typed next to a deleted one inherits from it (see `state`), as
 *   if it were still there.
 */
export type Ghost = {
  readonly s: string;
  /** It only moves back over ids deleted right before it (see `add`). */
  c: number;
  len: number;
  /** The anchor: a letter `(as, ac)`, or the start of node `as` (`ac = -1`). */
  as: string;
  ac: number;
  /**
   * The keys of their state that a letter can inherit (see `Inherit`), one
   * object per distinct state: only ghosts with the same one are joined.
   */
  readonly state: Readonly<Record<string, Json>> | undefined;
};

/** Up to how many ghosts of one anchor are looked at one by one (see `add`). */
const SCAN = 16;

/** Whether `ghost` is anchored at `(as, ac)` and has `state`: it can join. */
const sameSpot = (
  ghost: Ghost,
  as: string,
  ac: number,
  state: Ghost["state"],
) => ghost.as === as && ghost.ac === ac && ghost.state === state;

/** Ghosts in the order they are stored: by session, then counter. */
const byId = (a: Ghost, b: Ghost) =>
  a.s < b.s ? -1 : a.s > b.s ? 1 : a.c - b.c;

export class Ghosts {
  /** By session, sorted by counter (see `SessionRuns`). */
  #ids = new Map<string, SessionRuns<Ghost>>();
  /** By the session of their anchor (the node, for a start), then its counter. */
  #anchors = new Map<string, Map<number, Ghost[]>>();

  /**
   * Joins the ghosts of one anchor whose ids follow each other, after
   * `moved` came to it.
   */
  #join(list: Ghost[], moved: Ghost[]): void {
    for (let ghost of moved) {
      // Merged into another one: `len` 0.
      if (ghost.len === 0) continue;
      for (let joined = true; joined; ) {
        joined = false;
        const [prev, next] = this.#around(
          list,
          ghost.s,
          ghost.c,
          ghost.len,
          ghost.state,
        );
        if (prev) {
          prev.len += ghost.len;
          this.#remove(ghost);
          ghost = prev;
          joined = true;
        }
        if (next) {
          ghost.len += next.len;
          this.#remove(next);
          joined = true;
        }
      }
    }
  }

  /** Whether any of the `length` ids of `s` from `c` is a ghost. */
  overlaps(s: string, c: number, length: number): boolean {
    return this.#ids.get(s)?.overlaps(c, length) ?? false;
  }

  /**
   * The ghosts of `s` right before and after ids `[c, c + len)` among those
   * of one anchor, `list`, with `state`: they can take these ids.
   */
  #around(
    list: Ghost[],
    s: string,
    c: number,
    len: number,
    state: Ghost["state"],
  ): [Ghost | undefined, Ghost | undefined] {
    let prev: Ghost | undefined;
    let next: Ghost | undefined;
    if (list.length <= SCAN) {
      for (const ghost of list)
        if (ghost.s === s && ghost.state === state)
          if (ghost.c + ghost.len === c) prev = ghost;
          else if (ghost.c === c + len) next = ghost;
    } else {
      // The anchor of the list: of any of its ghosts.
      const { as, ac } = list[0]!;
      prev = this.find(s, c - 1);
      if (prev && !sameSpot(prev, as, ac, state)) prev = undefined;
      next = this.find(s, c + len);
      if (next && !sameSpot(next, as, ac, state)) next = undefined;
    }
    return [prev, next];
  }

  /** The counter after the last ghost of `s`, or 0. */
  end(s: string): number {
    return this.#ids.get(s)?.end() ?? 0;
  }

  /** Ids `[c, c + len)` of `s` are live again. */
  drop(s: string, c: number, len: number): void {
    const end = c + len;
    for (let at = c; at < end; at++) {
      const ghost = this.find(s, at);
      // Letters it never had (see `BaseText._applyRestore`).
      if (!ghost) continue;
      const { c: from, len: length, as, ac, state } = ghost;
      this.#remove(ghost);
      if (from < c) this.#put({ s, c: from, len: c - from, as, ac, state });
      if (from + length > end)
        this.#put({ s, c: end, len: from + length - end, as, ac, state });
      at = from + length - 1;
    }
  }

  /** Whether a ghost is anchored at the start of `node`'s text. */
  hasStart(node: string): boolean {
    return this.#anchors.get(node)?.has(-1) ?? false;
  }

  /**
   * Ids `[c, c + len)` of `s`, with `state`, were deleted right after
   * `(as, ac)`. The ghosts anchored at them move there too (`anchors`:
   * whether there may be some).
   */
  add(
    s: string,
    c: number,
    len: number,
    as: string,
    ac: number,
    anchors: boolean,
    state: Ghost["state"],
  ): void {
    const moved = anchors ? this.#takeAnchored(s, c, len) : [];
    for (const other of moved) {
      other.as = as;
      other.ac = ac;
      this.#anchor(other);
    }
    // A ghost of the ids right before or after, at the same anchor and with
    // the same state, takes these ids: deleting letters one by one leaves
    // one ghost.
    const list = this.#anchors.get(as)?.get(ac);
    const [prev, next] = list
      ? this.#around(list, s, c, len, state)
      : [undefined, undefined];
    if (next) {
      if (prev) {
        prev.len += len + next.len;
        this.#remove(next);
      } else {
        // No ghost has the ids in between: the order by counter stays.
        next.c = c;
        next.len += len;
      }
    } else if (prev) prev.len += len;
    else this.#put({ s, c, len, as, ac, state });
    if (moved.length > 0) this.#join(this.#anchors.get(as)!.get(ac)!, moved);
  }

  #anchor(ghost: Ghost): void {
    let anchored = this.#anchors.get(ghost.as);
    if (!anchored)
      this.#anchors.set(ghost.as, (anchored = new Map<number, Ghost[]>()));
    const list = anchored.get(ghost.ac);
    if (list) list.push(ghost);
    else anchored.set(ghost.ac, [ghost]);
  }

  /** A ghost read from a stored text: `finish` indexes them all. */
  load(ghost: Ghost, loaded: Map<string, Ghost[]>): void {
    const list = loaded.get(ghost.s);
    if (list) list.push(ghost);
    else loaded.set(ghost.s, [ghost]);
    this.#anchor(ghost);
  }

  /**
   * The counters of the letters of `as` that anchor ghosts (`-1`: the start
   * of node `as`), sorted: see `at`.
   */
  anchorsOf(as: string): number[] {
    const anchored = this.#anchors.get(as);
    if (!anchored) return [];
    return [...anchored.keys()].sort((a, b) => a - b);
  }

  /** The ghost with id `(s, c)`. */
  find(s: string, c: number): Ghost | undefined {
    return this.#ids.get(s)?.find(c);
  }

  /** A ghost in both indexes. */
  #put(ghost: Ghost): void {
    let runs = this.#ids.get(ghost.s);
    if (!runs) this.#ids.set(ghost.s, (runs = new SessionRuns<Ghost>()));
    runs.add(ghost);
    this.#anchor(ghost);
  }

  /** The ghosts anchored at `(as, ac)`, in the order they are stored. */
  at(as: string, ac: number): Ghost[] {
    return this.#anchors.get(as)!.get(ac)!.sort(byId);
  }

  finish(loaded: Map<string, Ghost[]>): void {
    for (const [s, list] of loaded) this.#ids.set(s, SessionRuns.from(list));
  }

  get empty(): boolean {
    return this.#ids.size === 0;
  }

  /** Takes `ghost` out of both indexes. */
  #remove(ghost: Ghost): void {
    const runs = this.#ids.get(ghost.s)!;
    runs.remove(ghost);
    if (runs.empty) this.#ids.delete(ghost.s);
    const anchored = this.#anchors.get(ghost.as)!;
    const list = anchored.get(ghost.ac)!;
    list.splice(list.indexOf(ghost), 1);
    if (list.length === 0) {
      anchored.delete(ghost.ac);
      if (anchored.size === 0) this.#anchors.delete(ghost.as);
    }
    ghost.len = 0;
  }

  /**
   * Takes the ghosts anchored at ids `[c, c + len)` of `as` out of their
   * anchor.
   */
  #takeAnchored(as: string, c: number, len: number): Ghost[] {
    const anchored = this.#anchors.get(as);
    if (!anchored) return [];
    const moved: Ghost[] = [];
    const take = (ac: number) => {
      const list = anchored.get(ac);
      if (!list) return;
      anchored.delete(ac);
      for (const ghost of list) moved.push(ghost);
    };
    if (len <= anchored.size) for (let k = 0; k < len; k++) take(c + k);
    else
      for (const ac of [...anchored.keys()])
        if (ac >= c && ac < c + len) take(ac);
    if (anchored.size === 0) this.#anchors.delete(as);
    return moved;
  }
}
