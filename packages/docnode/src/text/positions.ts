// How a text engine finds the visible character at an index of a node's text.
// Both engines keep every list of characters as a linked list of runs; this
// index gets from an index to a run in O(log n).

/** What the index needs of a run of letters (and of a node's root). */
export type Item<R> = {
  readonly len: number;
  readonly visible: boolean;
  /** Bookkeeping of the index. */
  leaf: Leaf<R> | undefined;
  vis: number;
  next: R | undefined;
  /** Its list: one index each. */
  readonly flow: object;
};

/** A visible element and how many visible characters of its text precede its run. */
export type Seek<R> = { run: R; off: number; before: number };

/**
 * Finds positions in a node's text (its list after its root) and hears about
 * every change that moves them.
 */
export type Positions<R> = {
  /** The visible length of the text. */
  length(root: R): number;
  /** The visible element at `index`, which must be less than `length`. */
  seek(root: R, index: number): Seek<R>;
  /** `run`'s visible length changed. */
  changed(run: R): void;
  /** `run` was just linked right after (or before) `target`. */
  linked(target: R, run: R, after: boolean): void;
  /** `run` left its list (or was joined into the run before it). */
  removed(run: R): void;
  /** How many visible characters of `root`'s list are before `run`. */
  before(root: R, run: R): number;
};

/** Runs per leaf, at most twice this many before a leaf is cut in two. */
const LEAF = 32;

/** Children per inner node, at most, before it is cut in two. */
const FANOUT = 32;

export type Leaf<R> = { items: R[]; vis: number; parent: Inner<R> | undefined };
type Inner<R> = {
  children: TreeNode<R>[];
  vis: number;
  parent: Inner<R> | undefined;
};
type TreeNode<R> = Leaf<R> | Inner<R>;

const isLeaf = <R>(node: TreeNode<R>): node is Leaf<R> => "items" in node;
const visOf = <R>(run: Item<R>) => (run.visible ? run.len : 0);

/** An inner node over `children`, which it adopts. */
function innerOf<R>(children: TreeNode<R>[]): Inner<R> {
  const inner: Inner<R> = { children, vis: 0, parent: undefined };
  for (const child of children) {
    child.parent = inner;
    inner.vis += child.vis;
  }
  return inner;
}

/** A leaf of `items`, which it adopts. */
function leafOf<R extends Item<R>>(items: R[]): Leaf<R> {
  const leaf: Leaf<R> = { items, vis: 0, parent: undefined };
  for (const run of items) {
    run.leaf = leaf;
    run.vis = visOf(run);
    leaf.vis += run.vis;
  }
  return leaf;
}

/**
 * The runs of one flow in order, in leaves of about `LEAF` runs that know their
 * visible length, under a B-tree of inner nodes that sum their children.
 */
class FlowIndex<R extends Item<R>> {
  #root: TreeNode<R>;

  constructor(head: R) {
    const leaves: Leaf<R>[] = [];
    let items: R[] = [];
    for (let run: R | undefined = head; run; run = run.next) {
      if (items.length === LEAF) {
        leaves.push(leafOf(items));
        items = [];
      }
      items.push(run);
    }
    leaves.push(leafOf(items));
    let level: TreeNode<R>[] = leaves;
    do level = this.#group(level);
    while (level.length > 1);
    this.#root = level[0]!;
  }

  /**
   * The visible run holding visible character `vis`, with its offset in
   * `offset`. `vis` must be less than the total visible length.
   */
  findVisible(vis: number): R {
    let node = this.#root;
    while (!isLeaf(node)) {
      let index = 0;
      while (vis >= node.children[index]!.vis)
        vis -= node.children[index++]!.vis;
      node = node.children[index]!;
    }
    let index = 0;
    while (vis >= node.items[index]!.vis) vis -= node.items[index++]!.vis;
    this.offset = vis;
    return node.items[index]!;
  }

  get vis(): number {
    return this.#root.vis;
  }

  changed(run: R): void {
    const vis = visOf(run) - run.vis;
    if (vis === 0) return;
    run.vis += vis;
    this.#add(run.leaf, vis);
  }

  /** A leaf it leaves empty stays: lookups skip it, as it counts nothing. */
  remove(run: R): void {
    const leaf = run.leaf!;
    leaf.items.splice(leaf.items.indexOf(run), 1);
    this.#add(leaf, 0 - run.vis);
  }

  insert(target: R, run: R, after: boolean): void {
    const leaf = target.leaf!;
    const at = leaf.items.indexOf(target) + (after ? 1 : 0);
    run.leaf = leaf;
    run.vis = visOf(run);
    if (at === leaf.items.length) leaf.items.push(run);
    else leaf.items.splice(at, 0, run);
    this.#add(leaf, run.vis);
    if (leaf.items.length >= LEAF * 2) this.#splitLeaf(leaf);
  }

  #splitLeaf(leaf: Leaf<R>): void {
    const fresh = leafOf(leaf.items.splice(LEAF));
    leaf.vis -= fresh.vis;
    this.#adopt(leaf, fresh);
  }

  /** Puts `fresh` right after `node` under the same parent, splitting upwards. */
  #adopt(node: TreeNode<R>, fresh: TreeNode<R>): void {
    let parent = node.parent;
    if (!parent) {
      // A new root: it holds both halves of the old one.
      parent = innerOf([node]);
      parent.vis += fresh.vis;
      this.#root = parent;
    }
    fresh.parent = parent;
    parent.children.splice(parent.children.indexOf(node) + 1, 0, fresh);
    if (parent.children.length <= FANOUT) return;
    const sibling = innerOf(
      parent.children.splice(parent.children.length >> 1),
    );
    parent.vis -= sibling.vis;
    this.#adopt(parent, sibling);
  }

  /** The visible length of the runs before `run`: its leaf's, then up. */
  before(run: R): number {
    let node: TreeNode<R> = run.leaf!;
    let before = 0;
    for (const item of node.items) {
      if (item === run) break;
      before += item.vis;
    }
    for (let parent = node.parent; parent; parent = parent.parent) {
      for (const child of parent.children) {
        if (child === node) break;
        before += child.vis;
      }
      node = parent;
    }
    return before;
  }

  /** The offset in its run of the character `findVisible` last found. */
  offset = 0;

  /** Inner nodes over `nodes`, `FANOUT` at a time. */
  #group(nodes: TreeNode<R>[]): Inner<R>[] {
    const out: Inner<R>[] = [];
    for (let i = 0; i < nodes.length; i += FANOUT)
      out.push(innerOf(nodes.slice(i, i + FANOUT)));
    return out;
  }

  #add(node: TreeNode<R> | undefined, vis: number): void {
    for (; node; node = node.parent) node.vis += vis;
  }
}

/** The B-tree position index of every flow, built the first time it is needed. */
export class TreePositions<R extends Item<R>> implements Positions<R> {
  readonly #indexes = new WeakMap<object, FlowIndex<R>>();

  /** The index of `root`'s list, built from it the first time. */
  #indexOf(root: R): FlowIndex<R> {
    let index = this.#indexes.get(root.flow);
    if (!index) {
      index = new FlowIndex(root);
      this.#indexes.set(root.flow, index);
    }
    return index;
  }

  length(root: R): number {
    return this.#indexOf(root).vis;
  }

  changed(run: R): void {
    this.#indexes.get(run.flow)?.changed(run);
  }

  before(root: R, run: R): number {
    return this.#indexOf(root).before(run);
  }

  removed(run: R): void {
    this.#indexes.get(run.flow)?.remove(run);
  }

  seek(root: R, index: number): Seek<R> {
    const flow = this.#indexOf(root);
    const run = flow.findVisible(index);
    const off = flow.offset;
    return { run, off, before: index - off };
  }

  linked(target: R, run: R, after: boolean): void {
    this.#indexes.get(target.flow)?.insert(target, run, after);
  }
}
