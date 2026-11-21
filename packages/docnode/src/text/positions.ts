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
const LEAF = 64;
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

/**
 * The runs of one flow in order, in leaves of about `LEAF` runs that know their
 * visible length, under a B-tree of inner nodes that sum their children.
 */
class FlowIndex<R extends Item<R>> {
  private _root: TreeNode<R>;

  constructor(head: R) {
    const leaves: Leaf<R>[] = [];
    let leaf: Leaf<R> | undefined;
    for (let run: R | undefined = head; run; run = run.next) {
      if (!leaf || leaf.items.length === LEAF) {
        leaf = { items: [], vis: 0, parent: undefined };
        leaves.push(leaf);
      }
      this._attach(leaf, run, leaf.items.length);
    }
    let level: TreeNode<R>[] = leaves;
    do level = this._group(level);
    while (level.length > 1);
    this._root = level[0]!;
  }

  /** Inner nodes over `nodes`, `FANOUT` at a time. */
  private _group(nodes: TreeNode<R>[]): Inner<R>[] {
    const out: Inner<R>[] = [];
    for (let i = 0; i < nodes.length; i += FANOUT) {
      const inner: Inner<R> = { children: [], vis: 0, parent: undefined };
      for (const child of nodes.slice(i, i + FANOUT)) {
        child.parent = inner;
        inner.children.push(child);
        inner.vis += child.vis;
      }
      out.push(inner);
    }
    return out;
  }

  private _attach(leaf: Leaf<R>, run: R, at: number): void {
    run.leaf = leaf;
    run.vis = visOf(run);
    if (at === leaf.items.length) leaf.items.push(run);
    else leaf.items.splice(at, 0, run);
    leaf.vis += run.vis;
  }

  private _add(node: TreeNode<R> | undefined, vis: number): void {
    for (; node; node = node.parent) node.vis += vis;
  }

  insert(target: R, run: R, after: boolean): void {
    const leaf = target.leaf!;
    this._attach(leaf, run, leaf.items.indexOf(target) + (after ? 1 : 0));
    this._add(leaf.parent, run.vis);
    if (leaf.items.length >= LEAF * 2) this._splitLeaf(leaf);
  }

  /** A leaf it leaves empty stays: lookups skip it, as it counts nothing. */
  remove(run: R): void {
    const leaf = run.leaf!;
    leaf.items.splice(leaf.items.indexOf(run), 1);
    this._add(leaf, 0 - run.vis);
  }

  changed(run: R): void {
    const vis = visOf(run) - run.vis;
    if (vis === 0) return;
    run.vis += vis;
    this._add(run.leaf, vis);
  }

  private _splitLeaf(leaf: Leaf<R>): void {
    const fresh: Leaf<R> = { items: [], vis: 0, parent: undefined };
    for (const run of leaf.items.splice(LEAF)) {
      this._attach(fresh, run, fresh.items.length);
      leaf.vis -= run.vis;
    }
    this._adopt(leaf, fresh);
  }

  /** Puts `fresh` right after `node` under the same parent, splitting upwards. */
  private _adopt(node: TreeNode<R>, fresh: TreeNode<R>): void {
    let parent = node.parent;
    if (!parent) {
      // A new root: it holds both halves of the old one.
      parent = {
        children: [node],
        vis: node.vis + fresh.vis,
        parent: undefined,
      };
      node.parent = parent;
      this._root = parent;
    }
    fresh.parent = parent;
    parent.children.splice(parent.children.indexOf(node) + 1, 0, fresh);
    if (parent.children.length <= FANOUT) return;
    const half = parent.children.splice(parent.children.length >> 1);
    const sibling: Inner<R> = { children: [], vis: 0, parent: undefined };
    for (const child of half) {
      child.parent = sibling;
      sibling.children.push(child);
      sibling.vis += child.vis;
    }
    parent.vis -= sibling.vis;
    this._adopt(parent, sibling);
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

  get vis(): number {
    return this._root.vis;
  }

  /**
   * The visible run holding visible character `vis`, with its offset in
   * `offset`. `vis` must be less than the total visible length.
   */
  findVisible(vis: number): R {
    let node = this._root;
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
}

/** The B-tree position index of every flow, built the first time it is needed. */
export class TreePositions<R extends Item<R>> implements Positions<R> {
  private readonly _indexes = new WeakMap<object, FlowIndex<R>>();

  /** The index of `root`'s list, built from it the first time. */
  private _indexOf(root: R): FlowIndex<R> {
    let index = this._indexes.get(root.flow);
    if (!index) {
      index = new FlowIndex(root);
      this._indexes.set(root.flow, index);
    }
    return index;
  }

  seek(root: R, index: number): Seek<R> {
    const flow = this._indexOf(root);
    const run = flow.findVisible(index);
    const off = flow.offset;
    return { run, off, before: index - off };
  }

  length(root: R): number {
    return this._indexOf(root).vis;
  }

  changed(run: R): void {
    this._indexes.get(run.flow)?.changed(run);
  }

  linked(target: R, run: R, after: boolean): void {
    this._indexes.get(target.flow)?.insert(target, run, after);
  }

  removed(run: R): void {
    this._indexes.get(run.flow)?.remove(run);
  }

  before(root: R, run: R): number {
    return this._indexOf(root).before(run);
  }
}
