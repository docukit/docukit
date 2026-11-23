import { describe, expect, test } from "vitest";

import {
  _INTERNAL_decodeOperations as decodeOperations,
  defineNode,
  Doc,
  string,
  type ChangeEvent,
  type DocNode,
  type Operations,
} from "@docukit/docnode";
import { labelsEngine, labelsSnapshot } from "@docukit/docnode/crdt";

import { Text, TextExtension } from "../../utils.js";
import {
  createReplica,
  deliver,
  expectSameTree,
  insert,
  restoreReplica,
  storedLabels,
  syncAll,
  take,
  tree,
  value,
  type Replica,
} from "./utils.js";

const OPTIONS = [{ undo: "lives" }, { undo: "newId" }] as const;

/** A whole snapshot delivered as one operation, as a replica does after a crash. */
const snapshotOf = (replica: Replica) => labelsSnapshot(replica.doc.toJSON());

function pair(options: (typeof OPTIONS)[number] = OPTIONS[0]) {
  const a = createReplica({ peer: "a", ...options });
  const b = createReplica({ peer: "b", ...options });
  return { a, b };
}

/** Delivers to every permutation of the batches a fresh replica, with repeats. */
function expectAnyOrder(reference: Replica, batches: Operations[][]) {
  const flat = batches.flat();
  const permutations = (items: Operations[]): Operations[][] =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, index) =>
          permutations([
            ...items.slice(0, index),
            ...items.slice(index + 1),
          ]).map((rest) => [item, ...rest]),
        );
  for (const order of permutations(flat)) {
    const peer = createReplica({ peer: "observer" });
    deliver(peer, [...order, ...order]);
    expect(tree(peer)).toBe(tree(reference));
  }
}

describe("merging", () => {
  test("insert, delete, move and state merge the same in any order", () => {
    const { a, b } = pair();
    const x = insert(a, a.doc.root, "x");
    const y = insert(a, a.doc.root, "y");
    const before = take(a);
    deliver(b, before);
    const bx = b.doc.getNodeById(x.id)!;
    const bz = insert(b, b.doc.root, "z");
    y.delete();
    a.doc.forceCommit();
    if (bx.is(Text)) bx.state.value.set("x2");
    bz.move(bx, "append");
    b.doc.forceCommit();
    const fromA = take(a);
    const fromB = take(b);
    deliver(a, fromB);
    deliver(b, fromA);
    expectSameTree(a, b);
    expect(tree(a)).toBe("root(x2(z))");
    expectAnyOrder(a, [before.slice(0, 2), fromA, fromB]);
  });

  test("repeated operations change nothing", () => {
    const { a, b } = pair();
    insert(a, a.doc.root, "x");
    const ops = take(a);
    deliver(b, ops);
    const stored = JSON.stringify(b.doc.toJSON());
    let events = 0;
    b.doc.onChange(() => events++);
    deliver(b, ops);
    expect(events).toBe(0);
    expect(JSON.stringify(b.doc.toJSON())).toBe(stored);
  });

  test("state and move that arrive before the insert wait for it", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    const child = insert(a, a.doc.root, "child");
    if (child.is(Text)) child.state.value.set("final");
    a.doc.forceCommit();
    child.move(parent, "append");
    a.doc.forceCommit();
    const [insertParent, insertChild, setChild, moveChild] = take(a);
    deliver(b, [moveChild!, setChild!, insertChild!, insertParent!]);
    expect(tree(b)).toBe("root(parent(final))");
  });

  test("LWW resolves concurrent writes with the same result on both sides", () => {
    const { a, b } = pair();
    const x = insert(a, a.doc.root, "x");
    const base = take(a);
    deliver(b, base);
    const bx = b.doc.getNodeById(x.id)!;
    if (x.is(Text)) x.state.value.set("from a");
    if (bx.is(Text)) bx.state.value.set("from b");
    a.doc.forceCommit();
    b.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    expect(value(a.doc.root.first!)).toBe("from b");
  });

  test("a remote change sends its batch on, with no inverse to undo it", () => {
    const { a, b } = pair();
    const events: ChangeEvent[] = [];
    b.doc.onChange((event) => events.push(event));
    insert(a, a.doc.root, "x");
    const [batch] = take(a);
    deliver(b, [batch!]);
    const [event] = events;
    expect(event!.operations).toStrictEqual(batch);
    expect(decodeOperations(event!.inverseOperations)[0]).toStrictEqual([]);
  });

  test("a local edit sends labels", () => {
    const { a } = pair();
    let sent: unknown;
    a.doc.onChange((event) => {
      sent = event.operations[1];
    });
    insert(a, a.doc.root, "x");
    // The node is written by its distance from the head's counter: `1`. It
    // starts its list: its place's origin is the list's start, `0`.
    expect(sent).toStrictEqual([3, 0, [[0, [1, "text", 0]]]]);
  });
});

describe("deletes", () => {
  test("an insert into a concurrently deleted parent stays hidden and returns with its parent", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    deliver(b, take(a));
    const bParent = b.doc.getNodeById(parent.id)!;
    insert(b, bParent, "child");
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toBe("root");
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toBe("root(parent(child))");
  });

  test("a move into a concurrently deleted parent falls back to where it was", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    const item = insert(a, a.doc.root, "item");
    deliver(b, take(a));
    b.doc.getNodeById(item.id)!.move(b.doc.getNodeById(parent.id)!, "append");
    b.doc.forceCommit();
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toBe("root(item)");
  });

  test("a move out of a concurrently deleted subtree wins", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    const child = insert(a, parent, "child");
    const other = insert(a, a.doc.root, "other");
    deliver(b, take(a));
    b.doc.getNodeById(child.id)!.move(b.doc.getNodeById(other.id)!, "append");
    b.doc.forceCommit();
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toBe("root(other(child))");
  });

  test("an old client editing deleted nodes changes nothing", () => {
    const { a, b } = pair();
    const x = insert(a, a.doc.root, "x");
    deliver(b, take(a));
    const stale = b.doc.getNodeById(x.id)!;
    if (stale.is(Text)) stale.state.value.set("late");
    b.doc.forceCommit();
    const lateEdit = take(b);
    x.delete();
    a.doc.forceCommit();
    deliver(a, lateEdit);
    deliver(b, take(a));
    expect(tree(a)).toBe("root");
    expectSameTree(a, b);
  });

  test("delete ranges stay compact and survive a snapshot", () => {
    const { a } = pair();
    const nodes = [1, 2, 3].map((n) => insert(a, a.doc.root, String(n)));
    take(a);
    nodes[0]!.to(nodes[2]!).delete();
    a.doc.forceCommit();
    // One range of the first session of the table (0 is `""`).
    expect(storedLabels(a.doc).deleted).toStrictEqual([
      [1, expect.any(Number), expect.any(Number), 0],
    ]);
  });

  test("an id with no numeric suffix is its own session", () => {
    const a = createReplica({ peer: "a", plainIds: true });
    const b = createReplica({ peer: "b", plainIds: true });
    const x = insert(a, a.doc.root, "x");
    deliver(b, take(a));
    x.delete();
    a.doc.forceCommit();
    deliver(b, take(a));
    expect(tree(b)).toBe("root");
  });
});

describe("undo", () => {
  test.each(OPTIONS)("delete and undo round-trip with $undo", (options) => {
    const { a, b } = pair(options);
    insert(a, a.doc.root, "x");
    insert(a, a.doc.root, "y");
    syncAll(a, b);
    a.doc.root.first!.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root(x,y)");
    expectSameTree(a, b);
    a.doc.undoManager.redo();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root(y)");
    expectSameTree(a, b);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root(x,y)");
    expectSameTree(a, b);
  });

  test("lives: an old repeated insert does not bring a node back", () => {
    const { a, b } = pair();
    const x = insert(a, a.doc.root, "x");
    const firstInsert = take(a);
    deliver(b, firstInsert);
    x.delete();
    a.doc.forceCommit();
    deliver(b, take(a));
    deliver(b, firstInsert);
    expect(tree(b)).toBe("root");
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    deliver(b, take(a));
    deliver(b, firstInsert);
    expect(tree(b)).toBe("root(x)");
    expectSameTree(a, b);
  });

  test("newId: undo creates a fresh id and the stack still names the node", () => {
    const { a, b } = pair(OPTIONS[1]);
    const x = insert(a, a.doc.root, "x");
    const original = x.id;
    syncAll(a, b);
    x.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    const restored = a.doc.root.first!;
    expect(restored.id).not.toBe(original);
    expect(tree(b)).toBe("root(x)");
    a.doc.undoManager.redo();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root");
    expectSameTree(a, b);
  });

  test("the undo of an insert names only its own nodes", () => {
    const { a, b } = pair();
    const x = insert(a, a.doc.root, "x");
    syncAll(a, b);
    const [first, second] = [a.doc.createNode(Text), a.doc.createNode(Text)];
    first.state.value.set("first");
    second.state.value.set("second");
    x.insertAfter(first, second);
    a.doc.forceCommit();
    deliver(b, take(a));
    const fromB = insert(b, b.doc.root, "b");
    deliver(a, take(b));
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toContain(value(fromB));
    expect(tree(a)).not.toContain("first");
  });

  test("the undo of a move whose anchors are gone stays where it can", () => {
    const { a, b } = pair();
    const left = insert(a, a.doc.root, "left");
    const item = insert(a, a.doc.root, "item");
    const right = insert(a, a.doc.root, "right");
    syncAll(a, b);
    item.move(right, "after");
    a.doc.forceCommit();
    deliver(b, take(a));
    b.doc.getNodeById(left.id)!.delete();
    b.doc.forceCommit();
    deliver(a, take(b));
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
  });

  test("the undo of a move into a descendant is dropped", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    const child = insert(a, parent, "child");
    syncAll(a, b);
    child.move(a.doc.root, "append");
    a.doc.forceCommit();
    parent.move(child, "append");
    a.doc.forceCommit();
    syncAll(a, b);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
  });

  test("the undo of a move whose parent died is dropped", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    const item = insert(a, parent, "item");
    syncAll(a, b);
    item.move(a.doc.root, "append");
    a.doc.forceCommit();
    syncAll(a, b);
    b.doc.getNodeById(parent.id)!.delete();
    b.doc.forceCommit();
    syncAll(a, b);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toBe("root(item)");
  });

  test("undoing an insert of a node hidden by a dead parent shows it again", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    const item = insert(a, a.doc.root, "item");
    syncAll(a, b);
    item.move(parent, "append");
    a.doc.forceCommit();
    const moved = take(a);
    item.delete();
    a.doc.forceCommit();
    b.doc.getNodeById(parent.id)!.delete();
    b.doc.forceCommit();
    deliver(a, take(b));
    deliver(a, moved);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
  });

  test("undoing a range restores it even if neighbours changed", () => {
    const { a, b } = pair();
    const nodes = [1, 2, 3, 4].map((n) => insert(a, a.doc.root, String(n)));
    syncAll(a, b);
    nodes[1]!.to(nodes[2]!).delete();
    a.doc.forceCommit();
    syncAll(a, b);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root(1,2,3,4)");
    expectSameTree(a, b);
  });

  test("abort rolls back a transaction without labelling it", () => {
    const { a } = pair();
    insert(a, a.doc.root, "x");
    take(a);
    a.doc.root.first!.delete();
    a.doc.abort();
    a.doc.forceCommit();
    expect(tree(a)).toBe("root(x)");
    expect(take(a)).toStrictEqual([]);
  });
});

describe("cycles", () => {
  function crossMoves(options: (typeof OPTIONS)[number] = OPTIONS[0]) {
    const replicas = pair(options);
    const { a, b } = replicas;
    const x = insert(a, a.doc.root, "x");
    const y = insert(a, a.doc.root, "y");
    syncAll(a, b);
    x.move(y, "append");
    a.doc.forceCommit();
    b.doc.getNodeById(y.id)!.move(b.doc.getNodeById(x.id)!, "append");
    b.doc.forceCommit();
    syncAll(a, b);
    return { ...replicas, x, y };
  }

  test.each(OPTIONS)(
    "a concurrent cycle converges with undo $undo",
    (options) => {
      const { a, b } = crossMoves(options);
      expectSameTree(a, b);
      expect(tree(a)).toMatch(/^root\([xy]\([xy]\)\)$/);
    },
  );

  test("a cut survives a snapshot and keeps parent pointers", () => {
    const { a, b } = crossMoves();
    const restored = restoreReplica(a, "c");
    expect(tree(restored)).toBe(tree(a));
    expectSameTree(a, b);
  });

  test("a cancelled move does not come back", () => {
    const { a, b, x, y } = crossMoves(OPTIONS[1]);
    const other = insert(a, a.doc.root, "other");
    syncAll(a, b);
    other.move(y, "append");
    a.doc.forceCommit();
    syncAll(a, b);
    x.move(a.doc.root, "append");
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toContain("y");
    expect(a.doc["_crdt"]).toBeDefined();
    expectSameTree(a, b);
    expect(value(x)).toBe("x");
  });
});

describe("edge cases", () => {
  test("a higher life that arrives first replaces the old entry", () => {
    const { a, b } = pair();
    const x = insert(a, a.doc.root, "x");
    syncAll(a, b);
    x.delete();
    a.doc.forceCommit();
    const del = take(a);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    const undo = take(a);
    deliver(b, undo);
    deliver(b, del);
    expectSameTree(a, b);
    expect(tree(b)).toBe("root(x)");
  });

  test("an operation for an older life is ignored", () => {
    const { a, b } = pair();
    const x = insert(a, a.doc.root, "x");
    syncAll(a, b);
    if (x.is(Text)) x.state.value.set("old life");
    a.doc.forceCommit();
    const oldEdit = take(a);
    x.delete();
    a.doc.forceCommit();
    const del = take(a);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    deliver(b, take(a));
    deliver(b, oldEdit);
    deliver(b, del);
    expect(tree(b)).toBe(tree(a));
  });

  test("ids that do not end in a clock are their own session", () => {
    const ids = ["x.", "x.!", "x.123456789", "x.-1"];
    let next = 0;
    const doc = new Doc({
      id: "01jz0000000000000000000000",
      type: "root",
      extensions: [TextExtension],
      crdt: labelsEngine(),
      nodeIdGenerator: {
        generate: () => ids[next++] ?? "y.1",
        validate: () => true,
      },
    });
    doc.forceCommit();
    const nodes = ids.map(() => doc.createNode(Text));
    doc.root.append(...nodes);
    doc.forceCommit();
    doc.root.first!.to(doc.root.last!).delete();
    doc.forceCommit();
    expect(doc.root.first).toBeUndefined();
  });

  test("two inserts in the same gap with equal keys re-sort the next one", () => {
    const { a, b } = pair(OPTIONS[1]);
    insert(a, a.doc.root, "first");
    syncAll(a, b);
    const left = a.doc.createNode(Text);
    left.state.value.set("left");
    a.doc.root.prepend(left);
    a.doc.forceCommit();
    const right = b.doc.createNode(Text);
    right.state.value.set("right");
    b.doc.root.prepend(right);
    b.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    const local = a.doc.createNode(Text);
    local.state.value.set("between");
    left.insertAfter(local);
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
  });

  test("a delete of non contiguous descendants sends one range per run", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    insert(a, parent, "one");
    insert(a, a.doc.root, "other");
    insert(a, parent, "two");
    syncAll(a, b);
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(b)).toBe("root(other)");
  });

  test("a child of a hidden parent stays linked under it", () => {
    const { a, b } = pair();
    const grand = insert(a, a.doc.root, "grand");
    syncAll(a, b);
    const parent = insert(b, b.doc.getNodeById(grand.id)!, "parent");
    const fromB = take(b);
    grand.delete();
    a.doc.forceCommit();
    deliver(a, fromB);
    const child = insert(b, b.doc.getNodeById(parent.id)!, "child");
    deliver(a, take(b));
    expect(tree(a)).toBe("root");
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    deliver(b, take(a));
    expect(tree(a)).toBe(`root(grand(parent(${value(child)})))`);
    expectSameTree(a, b);
  });

  test("undoing a limbo node restores it using the next anchor", () => {
    const { a, b } = pair();
    const dead = insert(a, a.doc.root, "dead");
    const item = insert(a, a.doc.root, "item");
    const tail = insert(a, a.doc.root, "tail");
    syncAll(a, b);
    item.delete();
    a.doc.forceCommit();
    b.doc.getNodeById(dead.id)!.delete();
    b.doc.forceCommit();
    syncAll(a, b);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toBe(`root(item,${value(tail)})`);
  });

  test("newId: a chain of undos keeps following the node", () => {
    const { a, b } = pair(OPTIONS[1]);
    const x = insert(a, a.doc.root, "x");
    syncAll(a, b);
    const original = x.id;
    for (let i = 0; i < 2; i++) {
      a.doc.root.first!.delete();
      a.doc.forceCommit();
      syncAll(a, b);
      a.doc.undoManager.undo();
      a.doc.forceCommit();
      syncAll(a, b);
    }
    expect(tree(a)).toBe("root(x)");
    expect(a.doc.root.first!.id).not.toBe(original);
    const copy = restoreReplica(a, "c", OPTIONS[1]);
    expect(tree(copy)).toBe("root(x)");
    expect(storedLabels(a.doc).aliases).toBeGreaterThan(0);
    expectSameTree(a, b);
    // The oldest entry still names the first id: the aliases lead to the last one.
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root");
    expectSameTree(a, b);
  });

  test("an undo naming a node that a peer revived under a dead parent is safe", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    const item = insert(a, parent, "item");
    syncAll(a, b);
    item.delete();
    a.doc.forceCommit();
    b.doc.getNodeById(item.id)!.delete();
    b.doc.forceCommit();
    b.doc.undoManager.undo();
    b.doc.forceCommit();
    b.doc.getNodeById(parent.id)!.delete();
    b.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root");
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root");
    expectSameTree(a, b);
  });

  test("state on the root keeps its stamp across a snapshot", () => {
    const RootState = defineNode({ type: "root", state: { b: string("") } });
    const config = {
      type: "root",
      extensions: [{ nodes: [RootState, Text] }],
      crdt: labelsEngine(),
      nodeIdGenerator: { generate: () => "z.0", validate: () => true },
    };
    const doc = new Doc({ ...config, id: "01jz0000000000000000000000" });
    doc.forceCommit();
    const root = doc.root;
    if (root.is(RootState)) root.state.b.set("one");
    doc.forceCommit();
    const restored = Doc.fromJSON({ ...config, id: doc.root.id }, doc.toJSON());
    restored.forceCommit();
    // The stamp of `z`, the first session of the table (0 is `""`).
    expect(storedLabels(restored).rootStamps).toStrictEqual([
      "b",
      expect.any(Number),
      1,
    ]);
    expect(restored.root.toJSON()[2]).toStrictEqual({ b: '"one"' });
  });

  test("a snapshot keeps a value that arrived before its node", () => {
    const { a, b } = pair();
    const x = insert(a, a.doc.root, "x");
    if (x.is(Text)) x.state.value.set("x2");
    a.doc.forceCommit();
    const [insertOp, setOp] = take(a);
    deliver(b, [setOp!]);
    const restored = restoreReplica(b, "c");
    deliver(restored, [insertOp!]);
    expect(tree(restored)).toBe("root(x2)");
  });

  test("a merged snapshot carries limbo entries, deletes and stamps", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    syncAll(a, b);
    insert(b, b.doc.getNodeById(parent.id)!, "orphan");
    const orphan = take(b);
    parent.delete();
    a.doc.forceCommit();
    deliver(a, orphan);
    const onlyLabels = createReplica({ peer: "fresh" });
    const snapshot = snapshotOf(a);
    deliver(onlyLabels, [snapshot]);
    expect(tree(onlyLabels)).toBe("root");
    deliver(onlyLabels, take(a));
    expect(JSON.stringify(onlyLabels.doc.toJSON())).toContain("orphan");
    const empty: Operations = ["", [4, ["x", "root", {}]]];
    deliver(onlyLabels, [empty]);
    expect(tree(onlyLabels)).toBe("root");
  });
});

describe("large sibling lists", () => {
  test("positions land correctly among many siblings on every path", () => {
    const { a, b } = pair();
    for (let n = 0; n < 80; n++) insert(a, a.doc.root, String(n));
    syncAll(a, b);
    const victim = a.doc.root.first!.next!;
    victim.delete();
    a.doc.forceCommit();
    const target = b.doc.root.last!;
    insert(b, b.doc.root, "tail");
    target.move(b.doc.root, "prepend");
    b.doc.forceCommit();
    const middle = b.doc.root.first!.next!.next!;
    const local = b.doc.createNode(Text);
    local.state.value.set("local");
    middle.insertAfter(local);
    b.doc.forceCommit();
    b.doc.root.last!.move(b.doc.root, "prepend");
    b.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    a.doc.root.first!.delete();
    a.doc.forceCommit();
    insert(a, a.doc.root, "again");
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toContain("again");
  });

  test("runs inserted in one transaction stay contiguous", () => {
    const { a, b } = pair(OPTIONS[1]);
    const anchor = insert(a, a.doc.root, "anchor");
    syncAll(a, b);
    const run = (replica: Replica, prefix: string) => {
      const nodes = [1, 2, 3].map((n) => {
        const node = replica.doc.createNode(Text);
        node.state.value.set(`${prefix}${n}`);
        return node;
      });
      replica.doc.getNodeById(anchor.id)!.insertAfter(...nodes);
      replica.doc.forceCommit();
    };
    run(a, "a");
    run(b, "b");
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toMatch(
      /root\(anchor,(a1,a2,a3,b1,b2,b3|b1,b2,b3,a1,a2,a3)\)/,
    );
  });

  test("a long run leaves a gap between every pair of its keys", () => {
    const { a, b } = pair(OPTIONS[1]);
    const nodes = Array.from({ length: 70 }, (_, n) => {
      const node = a.doc.createNode(Text);
      node.state.value.set(String(n));
      return node;
    });
    a.doc.root.append(...nodes);
    a.doc.forceCommit();
    nodes.forEach((node, n) => {
      const between = a.doc.createNode(Text);
      between.state.value.set(`${n}+`);
      node.insertAfter(between);
      a.doc.forceCommit();
    });
    const expected = nodes.flatMap((_, n) => [String(n), `${n}+`]).join(",");
    expect(tree(a)).toBe(`root(${expected})`);
    syncAll(a, b);
    expectSameTree(a, b);
    // No key fell out of its gap: a later edit does not move anything.
    take(a);
    nodes[0]!.state.value.set("edited");
    a.doc.forceCommit();
    // The label carries no inserts and no moves: `[3, clock]`.
    expect(JSON.stringify(take(a))).toMatch(/^\[\["[^"]*",\[3,\d+\],/);
  });

  test("concurrent runs typed in the same gap converge", () => {
    const options = OPTIONS[1];
    const { a, b } = pair(options);
    const anchor = insert(a, a.doc.root, "anchor");
    syncAll(a, b);
    const bAnchor = b.doc.getNodeById(anchor.id)!;
    const typeRun = (replica: Replica, start: DocNode, text: string) => {
      let previous = start;
      for (const letter of text) {
        const node = replica.doc.createNode(Text);
        node.state.value.set(letter);
        previous.insertAfter(node);
        replica.doc.forceCommit();
        previous = node;
      }
    };
    typeRun(a, anchor, "aa");
    typeRun(b, bAnchor, "bb");
    syncAll(a, b);
    expectSameTree(a, b);
  });
});

describe("normalize", () => {
  const setup = (normalizeRoot: boolean) => {
    const a = createReplica({ peer: "a", normalizeRoot });
    const b = createReplica({ peer: "b", normalizeRoot });
    const x = insert(a, a.doc.root, "x");
    syncAll(a, b);
    return { a, b, x };
  };

  test("a remote edit that empties the root is repaired once, on every replica", () => {
    const { a, b, x } = setup(true);
    x.delete();
    a.doc.forceCommit();
    b.doc.getNodeById(x.id)!.delete();
    b.doc.forceCommit();
    syncAll(a, b);
    expect(a.doc.root.first).toBeDefined();
    expect(a.doc.root.first).toBe(a.doc.root.last);
    expectSameTree(a, b);
  });

  test("a repair built by a remote edit uses a deterministic node", () => {
    const { a, b, x } = setup(true);
    const y = insert(b, b.doc.root, "y");
    syncAll(a, b);
    x.delete();
    a.doc.forceCommit();
    y.delete();
    b.doc.forceCommit();
    syncAll(a, b);
    expect(a.doc.root.first).toBeDefined();
    expect(a.doc.root.first).toBe(a.doc.root.last);
    expect(a.doc.root.first!.id).toBe(b.doc.root.first!.id);
    expectSameTree(a, b);
  });

  test("a repair falls back to the generator for ids it cannot use", () => {
    const ROOT = "01jz0000000000000000000000";
    const repaired = new Doc({
      id: "01jz0000000000000000000000",
      type: "root",
      extensions: [
        {
          nodes: [Text],
          register: (doc) => {
            doc.onNormalize(() => {
              if (!doc.root.first) doc.root.append(doc.createNode(Text));
            });
          },
        },
      ],
      crdt: labelsEngine(),
      nodeIdGenerator: {
        generate: () => "custom.0",
        validate: (id) => id === ROOT || id.startsWith("custom"),
      },
    });
    repaired.forceCommit();
    const peer = createReplica({ peer: "a", plainIds: true });
    insert(peer, peer.doc.root, "x");
    deliver({ doc: repaired, peer: "r", outbox: [] }, take(peer));
    peer.doc.root.first!.delete();
    peer.doc.forceCommit();
    deliver({ doc: repaired, peer: "r", outbox: [] }, take(peer));
    expect(repaired.root.first?.id).toBe("custom.0");
  });

  test("replaying operations does not run normalize", () => {
    const { a, b, x } = setup(false);
    x.delete();
    a.doc.forceCommit();
    deliver(b, take(a));
    expect(b.doc.root.first).toBeUndefined();
  });
});

describe("deleted subtrees", () => {
  test("a child moved out keeps its own children", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    const child = insert(a, parent, "child");
    insert(a, child, "grandchild");
    const other = insert(a, a.doc.root, "other");
    syncAll(a, b);
    b.doc.getNodeById(child.id)!.move(b.doc.getNodeById(other.id)!, "append");
    b.doc.forceCommit();
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toBe("root(other(child(grandchild)))");
  });

  test("the node moved into a deleted child falls back to where it was", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    const child = insert(a, parent, "child");
    const item = insert(a, a.doc.root, "item");
    syncAll(a, b);
    b.doc.getNodeById(item.id)!.move(b.doc.getNodeById(child.id)!, "append");
    b.doc.forceCommit();
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toBe("root(item)");
  });

  test("undoing a delete brings back the pending children everywhere", () => {
    const { a, b } = pair();
    const parent = insert(a, a.doc.root, "parent");
    insert(a, parent, "child");
    syncAll(a, b);
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root(parent(child))");
    expectSameTree(a, b);
  });

  test("an insert older than a re-insert does not overwrite its values", () => {
    const { a, b } = pair();
    const x = insert(a, a.doc.root, "x");
    syncAll(a, b);
    const bx = b.doc.getNodeById(x.id)!;
    if (bx.is(Text)) bx.state.value.set("late");
    b.doc.forceCommit();
    const lateEdit = take(b);
    x.delete();
    a.doc.forceCommit();
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    deliver(a, lateEdit);
    expectSameTree(a, b);
    expect(value(a.doc.root.first!)).toBe("x");
  });
});

describe("garbage collection", () => {
  const labels = (replica: Replica) =>
    JSON.stringify(replica.doc.toJSON().at(-1));

  test("the deleter removes pending descendants after the delay", () => {
    const a = createReplica({ peer: "a", gcDelay: 2 });
    const b = createReplica({ peer: "b", gcDelay: 2 });
    const parent = insert(a, a.doc.root, "parent");
    insert(a, parent, "child");
    insert(a, parent, "second child");
    syncAll(a, b);
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(storedLabels(b.doc).pending).toBeGreaterThan(0);
    insert(a, a.doc.root, "one");
    insert(a, a.doc.root, "two");
    insert(a, a.doc.root, "three");
    syncAll(a, b);
    expect(storedLabels(a.doc).pending).toBe(0);
    expect(storedLabels(b.doc).limbo).toBe(0);
    expectSameTree(a, b);
  });

  test("an insert under a deleted parent is removed by its author", () => {
    const a = createReplica({ peer: "a", gcDelay: 2 });
    const b = createReplica({ peer: "b", gcDelay: 2 });
    const parent = insert(a, a.doc.root, "parent");
    syncAll(a, b);
    insert(b, b.doc.getNodeById(parent.id)!, "orphan");
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(labels(a)).toContain("orphan");
    insert(b, b.doc.root, "one");
    insert(b, b.doc.root, "two");
    insert(b, b.doc.root, "three");
    syncAll(a, b);
    expect(labels(a)).not.toContain("orphan");
    expectSameTree(a, b);
  });

  test("a node rescued before the delay is not removed", () => {
    const a = createReplica({ peer: "a", gcDelay: 2 });
    const b = createReplica({ peer: "b", gcDelay: 2 });
    const parent = insert(a, a.doc.root, "parent");
    const child = insert(a, parent, "child");
    syncAll(a, b);
    b.doc.getNodeById(child.id)!.move(b.doc.root, "append");
    b.doc.forceCommit();
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    insert(a, a.doc.root, "one");
    insert(a, a.doc.root, "two");
    insert(a, a.doc.root, "three");
    syncAll(a, b);
    expect(tree(a)).toContain("child");
    expectSameTree(a, b);
  });
});

describe("hidden nodes", () => {
  test("a hidden node that moves under a visible parent appears", () => {
    const { a, b } = pair();
    const dead = insert(a, a.doc.root, "dead");
    const home = insert(a, a.doc.root, "home");
    syncAll(a, b);
    const item = insert(b, b.doc.getNodeById(dead.id)!, "item");
    const insertItem = take(b);
    item.move(b.doc.getNodeById(home.id)!, "append");
    b.doc.forceCommit();
    const moveItem = take(b);
    dead.delete();
    a.doc.forceCommit();
    deliver(a, insertItem);
    expect(tree(a)).toBe("root(home)");
    deliver(a, moveItem);
    expect(tree(a)).toBe("root(home(item))");
  });

  test("a visible node whose new parent is hidden disappears with it", () => {
    const { a, b } = pair();
    const dead = insert(a, a.doc.root, "dead");
    const item = insert(a, a.doc.root, "item");
    syncAll(a, b);
    const hidden = insert(b, b.doc.getNodeById(dead.id)!, "hidden");
    const insertHidden = take(b);
    b.doc.getNodeById(item.id)!.move(hidden, "append");
    b.doc.forceCommit();
    const moveItem = take(b);
    dead.delete();
    a.doc.forceCommit();
    deliver(a, insertHidden);
    deliver(a, moveItem);
    expect(tree(a)).toBe("root");
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    expect(tree(a)).toBe("root(dead(hidden(item)))");
  });
});

describe("snapshots", () => {
  test("a snapshot keeps labels, limbo nodes, sessions and stamps", () => {
    const { a, b } = pair();
    const x = insert(a, a.doc.root, "x");
    const y = insert(a, x, "y");
    if (y.is(Text)) y.state.value.set("y2");
    a.doc.forceCommit();
    const parent = insert(a, a.doc.root, "parent");
    syncAll(a, b);
    insert(b, b.doc.getNodeById(parent.id)!, "orphan");
    const orphan = take(b);
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    deliver(a, orphan);
    expect(tree(a)).toBe("root(x(y2))");
    const restored = restoreReplica(a, "c");
    expect(tree(restored)).toBe(tree(a));
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    deliver(restored, take(a));
    expect(tree(restored)).toBe("root(x(y2),parent(orphan))");
    expect(tree(a)).toBe("root(x(y2),parent(orphan))");
  });

  test("a document without labels gets deterministic ones", () => {
    const config = { type: "root", extensions: [TextExtension] };
    const plain = new Doc({ ...config, id: "01jz0000000000000000000000" });
    const node = plain.createNode(Text);
    node.state.value.set("x");
    plain.root.append(node);
    plain.forceCommit();
    const json = plain.toJSON();
    const load = () => {
      const doc = Doc.fromJSON(
        { id: plain.root.id, ...config, crdt: labelsEngine() },
        json,
      );
      doc.forceCommit();
      return doc;
    };
    const [left, right] = [load(), load()];
    expect(left.toJSON()).toStrictEqual(right.toJSON());
    expect(left.root.first?.id).toBe(node.id);
  });

  test("a snapshot merges idempotently as an operation", () => {
    const { a, b } = pair();
    insert(a, a.doc.root, "x");
    const x = a.doc.root.first!;
    if (x.is(Text)) x.state.value.set("x2");
    a.doc.forceCommit();
    syncAll(a, b);
    insert(b, b.doc.root, "y");
    a.doc.root.first!.delete();
    a.doc.forceCommit();
    // A stored document has no id: the snapshot is one of this document.
    const snapshot = labelsSnapshot(b.doc.toJSON());
    take(a);
    deliver(a, [snapshot, snapshot]);
    deliver(b, take(b));
    expect(tree(a)).toContain("y");
    expect(tree(a)).not.toContain("x2");
  });

  test("hydrating then editing in the same transaction labels only the new node", () => {
    const { a } = pair();
    insert(a, a.doc.root, "x");
    take(a);
    const copy = Doc.fromJSON(
      {
        id: a.doc.root.id,
        type: "root",
        extensions: [TextExtension],
        crdt: labelsEngine(),
        nodeIdGenerator: { generate: () => "c.0", validate: () => true },
      },
      a.doc.toJSON(),
    );
    let sent: Operations[] = [];
    copy.onChange((event) => {
      sent = [event.operations];
    });
    const node = copy.createNode(Text);
    copy.root.append(node);
    copy.forceCommit();
    // One insert: the new node, after the place of the hydrated one.
    expect(sent).toStrictEqual([
      [
        ["c.-", "a"],
        [3, 1, [[0, [".0", "text", "1.0"]]]],
      ],
    ]);
  });
});
