// The runs of a text in order, in a B-tree (ported from the closed #113,
// `text/positions.ts`): leaves of about `LEAF` runs that know how many letters
// they hold, under inner nodes that sum their children, as Loro keeps a text
// (`richtext_state.rs`). Going from an index to its run, or from a run to its
// index, is O(log n). With a flat list, every edit at a random place walked the
// text: B2.2-B2.4 (two replicas typing at random places) were up to 5 times
// slower than Yjs. Like Loro (`LazyLoad`), a loaded text keeps its runs as a
// list until an edit needs the tree: loading built it for nothing (B1.3-B1.7
// load +19-34 %).

/** What the tree needs of a run. */
type Item<R> = { readonly text: string; leaf: Leaf<R> | undefined };

export type Leaf<R> = {
  readonly items: R[];
  length: number;
  parent: Inner<R> | undefined;
};
type Inner<R> = {
  readonly children: Branch<R>[];
  length: number;
  parent: Inner<R> | undefined;
};
type Branch<R> = Leaf<R> | Inner<R>;

/** Runs per leaf, at most twice this many before a leaf is cut in two. */
const LEAF = 16;
/** Children per inner node, at most, before it is cut in two. */
const FANOUT = 16;

const isLeaf = <R>(node: Branch<R>): node is Leaf<R> => "items" in node;

/** Adds `length` letters to `node` and to the nodes above it. */
function grow<R>(node: Branch<R> | undefined, length: number) {
  for (; node; node = node.parent) node.length += length;
}

export class TextTree<R extends Item<R>> {
  /** The tree, once built. */
  private _root: Branch<R> | undefined;
  /** The runs until the tree is built, and how many letters they have. */
  private readonly _list: readonly R[];
  private readonly _length: number;
  /** The letters before the run `find` found last. */
  before = 0;

  /**
   * The runs `list`, in order, with `length` letters. The list can still be
   * filled after this: the tree is built the first time it is needed.
   */
  constructor(list: readonly R[], length: number) {
    this._list = list;
    this._length = length;
  }

  /** The root, which it builds the first time. */
  private _rootOf() {
    return (this._root ??= this._build(this._list));
  }

  private _build(runs: readonly R[]) {
    const leaves: Leaf<R>[] = [];
    for (let i = 0; i === 0 || i < runs.length; i += LEAF) {
      const leaf: Leaf<R> = { items: [], length: 0, parent: undefined };
      for (const run of runs.slice(i, i + LEAF)) {
        run.leaf = leaf;
        leaf.items.push(run);
        leaf.length += run.text.length;
      }
      leaves.push(leaf);
    }
    let level: Branch<R>[] = leaves;
    while (level.length > 1) level = this._group(level);
    return level[0]!;
  }

  /** Inner nodes over `nodes`, `FANOUT` at a time. */
  private _group(nodes: Branch<R>[]) {
    const out: Inner<R>[] = [];
    for (let i = 0; i < nodes.length; i += FANOUT) {
      const inner: Inner<R> = { children: [], length: 0, parent: undefined };
      for (const child of nodes.slice(i, i + FANOUT)) {
        child.parent = inner;
        inner.children.push(child);
        inner.length += child.length;
      }
      out.push(inner);
    }
    return out;
  }

  /** How many letters the runs have. */
  get length() {
    return this._root ? this._root.length : this._length;
  }

  /**
   * The run with the letter at `index`, which must be less than `length`,
   * and in `before` the letters before that run.
   */
  find(index: number) {
    let node = this._rootOf();
    let before = 0;
    while (!isLeaf(node)) {
      let at = 0;
      let child = node.children[0]!;
      while (index >= before + child.length) {
        before += child.length;
        child = node.children[++at]!;
      }
      node = child;
    }
    let at = 0;
    let run = node.items[0]!;
    while (index >= before + run.text.length) {
      before += run.text.length;
      run = node.items[++at]!;
    }
    this.before = before;
    return run;
  }

  /** How many letters are before `run`: in its leaf, then in the nodes up. */
  startOf(run: R) {
    this._rootOf();
    let node: Branch<R> = run.leaf!;
    let before = 0;
    for (const item of node.items) {
      if (item === run) break;
      before += item.text.length;
    }
    for (let parent = node.parent; parent; parent = parent.parent) {
      for (const child of parent.children) {
        if (child === node) break;
        before += child.length;
      }
      node = parent;
    }
    return before;
  }

  /** The runs in order. */
  runs(): readonly R[] {
    if (!this._root) return this._list;
    const runs: R[] = [];
    const add = (node: Branch<R>) => {
      if (isLeaf(node)) runs.push(...node.items);
      else for (const child of node.children) add(child);
    };
    add(this._root);
    return runs;
  }

  /** Puts `run` right after `target`, or first if `target` is undefined. */
  insert(target: R | undefined, run: R) {
    let leaf: Leaf<R>;
    let at = 0;
    if (target) {
      this._rootOf();
      leaf = target.leaf!;
      at = leaf.items.indexOf(target) + 1;
    } else {
      let node = this._rootOf();
      while (!isLeaf(node)) node = node.children[0]!;
      leaf = node;
    }
    run.leaf = leaf;
    leaf.items.splice(at, 0, run);
    grow(leaf, run.text.length);
    if (leaf.items.length >= LEAF * 2) this._splitLeaf(leaf);
  }

  /** Takes `run` out. A leaf it leaves empty stays: it counts no letters. */
  remove(run: R) {
    const leaf = run.leaf!;
    leaf.items.splice(leaf.items.indexOf(run), 1);
    grow(leaf, -run.text.length);
    run.leaf = undefined;
  }

  /** `run` has `length` more letters (fewer if negative). */
  resize(run: R, length: number) {
    grow(run.leaf, length);
  }

  private _splitLeaf(leaf: Leaf<R>) {
    const fresh: Leaf<R> = { items: [], length: 0, parent: undefined };
    for (const run of leaf.items.splice(LEAF)) {
      run.leaf = fresh;
      fresh.items.push(run);
      fresh.length += run.text.length;
    }
    leaf.length -= fresh.length;
    this._adopt(leaf, fresh);
  }

  /** Puts `fresh` right after `node` under the same parent, splitting up. */
  private _adopt(node: Branch<R>, fresh: Branch<R>) {
    let parent = node.parent;
    if (!parent) {
      // A new root: it holds both halves of the old one.
      parent = {
        children: [node],
        length: node.length + fresh.length,
        parent: undefined,
      };
      node.parent = parent;
      this._root = parent;
    }
    fresh.parent = parent;
    const children = parent.children;
    children.splice(children.indexOf(node) + 1, 0, fresh);
    if (children.length <= FANOUT) return;
    const sibling: Inner<R> = { children: [], length: 0, parent: undefined };
    for (const child of children.splice(children.length >> 1)) {
      child.parent = sibling;
      sibling.children.push(child);
      sibling.length += child.length;
    }
    parent.length -= sibling.length;
    this._adopt(parent, sibling);
  }
}
