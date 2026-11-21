import { describe, expect, test } from "vitest";

import { Doc, type Json } from "@docukit/docnode";
import { labelsEngine, labelsSnapshot } from "@docukit/docnode/crdt";

import { Text } from "../../utils.js";
import {
  createReplica,
  deliver,
  expectSameTree,
  insert,
  restoreReplica,
  ROOT_ID,
  syncAll,
  take,
  tree,
  type Replica,
} from "./utils.js";
import { written } from "../utils.js";

/** x in y on one side, y in x on the other: one of the moves is cut. */
function cycle(a: Replica, b: Replica) {
  const x = insert(a, a.doc.root, "x");
  const y = insert(a, a.doc.root, "y");
  syncAll(a, b);
  x.move(y, "append");
  a.doc.forceCommit();
  b.doc.getNodeById(y.id)!.move(b.doc.getNodeById(x.id)!, "append");
  b.doc.forceCommit();
  syncAll(a, b);
  return { x, y };
}

describe("affirmation of the cycle cut", () => {
  test("the next local move writes where the cut node is shown", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    cycle(a, b);
    // The node shown at the top is the one whose move was cut.
    const cut = a.doc.root.first!.id;
    const other = insert(a, a.doc.root, "other");
    syncAll(a, b);
    other.move(a.doc.root, "prepend");
    a.doc.forceCommit();
    const sent = a.outbox.at(-1)!;
    expect(JSON.stringify(sent)).toContain(
      `[${JSON.stringify(written(sent, cut))},0`,
    );
    syncAll(a, b);
    expectSameTree(a, b);
  });

  test("a cut node moved or deleted in the same transaction is not affirmed", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    cycle(a, b);
    // The cut node itself moves: its own move replaces the affirmation.
    a.doc.root.first!.move(a.doc.root, "append");
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    const c = createReplica({ peer: "c" });
    const d = createReplica({ peer: "d" });
    cycle(c, d);
    const extra = insert(c, c.doc.root, "extra");
    const last = insert(c, c.doc.root, "last");
    syncAll(c, d);
    // The cut node is deleted in the same transaction as another move.
    c.doc.root.first!.delete();
    extra.move(last, "after");
    c.doc.forceCommit();
    syncAll(c, d);
    expectSameTree(c, d);
    expect(tree(c)).toContain("extra");
  });
});

describe("transactions with several changes", () => {
  test("a node moved and deleted in one transaction is only deleted", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const x = insert(a, a.doc.root, "x");
    const y = insert(a, a.doc.root, "y");
    syncAll(a, b);
    x.move(y, "append");
    x.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(b)).toBe("root(y)");
  });

  test("nodes prepended one before the other in a transaction keep that order", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    insert(a, a.doc.root, "last");
    syncAll(a, b);
    const [second, first] = [a.doc.createNode(Text), a.doc.createNode(Text)];
    second.state.value.set("second");
    first.state.value.set("first");
    a.doc.root.prepend(second);
    a.doc.root.prepend(first);
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(b)).toBe("root(first,second,last)");
  });

  test("a node revived by undo keeps its life when moved", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const x = insert(a, a.doc.root, "x");
    const y = insert(a, a.doc.root, "y");
    syncAll(a, b);
    x.delete();
    a.doc.forceCommit();
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    a.doc.getNodeById(x.id)!.move(y, "append");
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(b)).toBe("root(y(x))");
  });

  test("undo restores a deleted grandchild under its revived parents", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const parent = insert(a, a.doc.root, "parent");
    const child = insert(a, parent, "child");
    insert(a, child, "grandchild");
    syncAll(a, b);
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root(parent(child(grandchild)))");
    expectSameTree(a, b);
  });

  test("two concurrent deletes of a parent agree on the newest view", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const parent = insert(a, a.doc.root, "parent");
    const child = insert(a, parent, "child");
    const sibling = insert(a, parent, "sibling");
    syncAll(a, b);
    child.move(sibling, "after");
    a.doc.forceCommit();
    parent.delete();
    a.doc.forceCommit();
    b.doc.getNodeById(parent.id)!.delete();
    b.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root");
    expectSameTree(a, b);
  });

  test("a delete of nodes with plain ids leaves their children pending", () => {
    const a = createReplica({ peer: "a", plainIds: true });
    const b = createReplica({ peer: "b", plainIds: true });
    const parent = insert(a, a.doc.root, "parent");
    insert(a, parent, "child");
    syncAll(a, b);
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(b)).toBe("root");
  });
});

describe("node ids", () => {
  test("a delete does not reach an id that only differs by a leading zero", () => {
    // "a.-5" is not `session.clock` ("a.5" is): two different nodes.
    const a = createReplica({ peer: "a", ids: ["a.5", "a.-5"] });
    const b = createReplica({ peer: "b" });
    const x = insert(a, a.doc.root, "x");
    const y = insert(a, a.doc.root, "y");
    syncAll(a, b);
    x.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    y.state.value.set("z");
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(b)).toBe("root(z)");
    expectSameTree(a, b);
  });
});

describe("normalize", () => {
  test("nodes created by normalize get ids every replica computes alike", () => {
    let armed = false;
    let next = 0;
    const doc = new Doc({
      id: ROOT_ID,
      type: "root",
      extensions: [
        {
          nodes: [Text],
          register: (d) => {
            d.onNormalize(() => {
              if (!armed || d.root.first) return;
              d.root.append(d.createNode(Text), d.createNode(Text));
            });
          },
        },
      ],
      crdt: labelsEngine(),
      nodeIdGenerator: { generate: () => `a.${next++}`, validate: () => true },
    });
    doc.forceCommit();
    armed = true;
    const x = doc.createNode(Text);
    doc.root.append(x);
    doc.forceCommit();
    x.delete();
    doc.forceCommit();
    const ids: string[] = [];
    doc.root.children().forEach((child) => ids.push(child.id));
    expect(ids).toStrictEqual(["r1.0", "r1.1"]);
  });
});

describe("snapshots with everything hidden kept", () => {
  /** a deletes a parent; b's child of it is pending; c holds a value early. */
  function busyReplica() {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const parent = insert(a, a.doc.root, "parent");
    insert(a, parent, "child");
    const x = insert(a, a.doc.root, "x");
    syncAll(a, b);
    insert(b, b.doc.getNodeById(parent.id)!, "orphan");
    // A value set back to the default keeps its stamp, not its value.
    const bx = b.doc.getNodeById(x.id)!;
    if (bx.is(Text)) bx.state.value.set("");
    b.doc.forceCommit();
    parent.delete();
    a.doc.forceCommit();
    x.delete();
    a.doc.forceCommit();
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    // A value set back to the default keeps its stamp, not its value.
    const ax = a.doc.getNodeById(x.id)!;
    if (ax.is(Text)) ax.state.value.set("tmp");
    a.doc.forceCommit();
    if (ax.is(Text)) ax.state.value.set("");
    a.doc.forceCommit();
    syncAll(a, b);
    // A value for a node whose insert has not arrived.
    const early = insert(b, b.doc.root, "early");
    const [insertEarly] = take(b);
    if (early.is(Text)) early.state.value.set("later");
    b.doc.forceCommit();
    deliver(a, take(b));
    return { a, b, insertEarly: insertEarly! };
  }

  test("restoring keeps pending deletes, early values and lives", () => {
    const { a, b, insertEarly } = busyReplica();
    expect(tree(restoreReplica(b, "d"))).toBe(tree(b));
    const copy = restoreReplica(a, "c");
    expect(tree(copy)).toBe(tree(a));
    deliver(copy, [insertEarly]);
    deliver(a, [insertEarly]);
    expect(tree(copy)).toBe(tree(a));
    expect(tree(a)).toContain("later");
    expectSameTree(a, b);
  });

  test("a snapshot merged into a fresh replica gives the same tree", () => {
    const { a, insertEarly } = busyReplica();
    const fresh = createReplica({ peer: "f" });
    const snapshot = labelsSnapshot(a.doc.toJSON());
    deliver(fresh, [snapshot]);
    deliver(fresh, [insertEarly]);
    deliver(a, [insertEarly]);
    expect(tree(fresh)).toBe(tree(a));
  });
});

describe("cycles inside a container", () => {
  test("the cut and the affirmation keep the container as parent", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const box = insert(a, a.doc.root, "box");
    const x = insert(a, box, "x");
    const y = insert(a, box, "y");
    syncAll(a, b);
    x.move(y, "append");
    a.doc.forceCommit();
    b.doc.getNodeById(y.id)!.move(b.doc.getNodeById(x.id)!, "append");
    b.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toMatch(/^root\(box\([xy]\([xy]\)\)\)$/);
    const other = insert(a, a.doc.root, "other");
    other.move(a.doc.root, "prepend");
    a.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
    // A peer that deletes the cut node: the others forget its cut too.
    b.doc.getNodeById(box.id)!.first!.delete();
    b.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
  });
});

describe("hidden subtrees", () => {
  test("a concurrent child of a deleted node returns with the undo", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const parent = insert(a, a.doc.root, "parent");
    const child = insert(a, parent, "child");
    syncAll(a, b);
    insert(b, b.doc.getNodeById(child.id)!, "late");
    insert(b, b.doc.getNodeById(child.id)!, "later");
    parent.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root");
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root(parent(child(late,later)))");
    expectSameTree(a, b);
  });

  test("a visible node moved into dead parents disappears", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const p = insert(a, a.doc.root, "p");
    const d = insert(a, a.doc.root, "d");
    const q = insert(a, a.doc.root, "q");
    syncAll(a, b);
    b.doc.getNodeById(q.id)!.move(b.doc.getNodeById(d.id)!, "append");
    b.doc.forceCommit();
    b.doc.getNodeById(q.id)!.move(b.doc.getNodeById(p.id)!, "append");
    b.doc.forceCommit();
    p.delete();
    d.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root");
    expectSameTree(a, b);
  });

  test("a move that arrives before its insert waits without a pointer", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const p = insert(a, a.doc.root, "p");
    const x = insert(a, a.doc.root, "x");
    const [insertP, insertX] = take(a);
    x.move(p, "append");
    a.doc.forceCommit();
    deliver(b, [insertP!, ...take(a)]);
    expect(tree(restoreReplica(b, "c"))).toBe(tree(b));
    x.delete();
    a.doc.forceCommit();
    deliver(b, take(a));
    deliver(b, [insertX!]);
    expect(tree(b)).toBe("root(p)");
  });

  test("a value older than the insert that brought a node back is ignored", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const x = a.doc.createNode(Text);
    a.doc.root.append(x);
    a.doc.forceCommit();
    syncAll(a, b);
    const bx = b.doc.getNodeById(x.id)!;
    if (bx.is(Text)) bx.state.value.set("late");
    b.doc.forceCommit();
    const late = take(b);
    x.delete();
    a.doc.forceCommit();
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    deliver(a, late);
    // The value is still the default: the late write did not apply.
    expect(tree(a)).toBe("root()");
  });

  test("the undo of a move uses the next anchor when the previous one is gone", () => {
    const a = createReplica({ peer: "a" });
    const prev = insert(a, a.doc.root, "prev");
    const item = insert(a, a.doc.root, "item");
    insert(a, a.doc.root, "next");
    item.move(a.doc.root, "append");
    a.doc.forceCommit();
    prev.delete();
    a.doc.forceCommit();
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    expect(tree(a)).toBe("root(prev,item,next)");
  });

  test("undoing a two-node insert leaves a node moved between them", () => {
    const a = createReplica({ peer: "a" });
    const anchor = insert(a, a.doc.root, "anchor");
    const z = insert(a, a.doc.root, "z");
    const [one, two] = [a.doc.createNode(Text), a.doc.createNode(Text)];
    anchor.insertAfter(one, two);
    z.move(one, "after");
    a.doc.forceCommit();
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    expect(tree(a)).toBe("root(anchor,z)");
  });

  test("a scheduled repair does nothing inside an open transaction", async () => {
    const a = createReplica({ peer: "a", normalizeRoot: true });
    const b = createReplica({ peer: "b", normalizeRoot: true });
    const x = insert(a, a.doc.root, "x");
    const y = insert(a, a.doc.root, "y");
    syncAll(a, b);
    x.delete();
    a.doc.forceCommit();
    b.doc.getNodeById(y.id)!.delete();
    b.doc.forceCommit();
    for (const operations of take(b)) {
      a.doc.applyOperations(operations, { skipUndo: true });
      a.doc.forceCommit();
    }
    // A local edit opens a transaction before the scheduled repair runs.
    a.doc.root.append(a.doc.createNode(Text));
    await Promise.resolve();
    a.doc.forceCommit();
    expect(a.doc.root.first).toBeDefined();
  });
});

describe("more hidden structure", () => {
  test("children of a hidden node stay in order and return with it", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const x = insert(a, a.doc.root, "x");
    syncAll(a, b);
    const box = insert(b, b.doc.getNodeById(x.id)!, "box");
    const two = insert(b, box, "two");
    const one = b.doc.createNode(Text);
    one.state.value.set("one");
    two.insertBefore(one);
    b.doc.forceCommit();
    insert(b, box, "three");
    x.delete();
    a.doc.forceCommit();
    deliver(a, take(b));
    expect(tree(a)).toBe("root");
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    expect(tree(a)).toBe("root(x(box(one,two,three)))");
    syncAll(a, b);
    expectSameTree(a, b);
  });

  test("an insert under a pending descendant is garbage of its author", () => {
    const a = createReplica({ peer: "a", gcDelay: 1 });
    const b = createReplica({ peer: "b", gcDelay: 1 });
    const parent = insert(a, a.doc.root, "parent");
    const child = insert(a, parent, "child");
    syncAll(a, b);
    const ops: ReturnType<typeof take> = [];
    insert(b, b.doc.getNodeById(child.id)!, "orphan");
    parent.delete();
    a.doc.forceCommit();
    ops.push(...a.outbox, ...b.outbox);
    syncAll(a, b);
    insert(b, b.doc.root, "one");
    insert(b, b.doc.root, "two");
    insert(a, a.doc.root, "three");
    ops.push(...b.outbox, ...a.outbox);
    syncAll(a, b);
    // Late copies of everything change nothing once removed.
    deliver(a, ops);
    deliver(b, ops);
    expect(JSON.stringify(a.doc.toJSON()[9])).not.toContain("orphan");
    expectSameTree(a, b);
  });
});

describe("values without a node", () => {
  test("a value for a node deleted before its insert arrives is dropped", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const x = insert(a, a.doc.root, "x");
    const [insertX] = take(a);
    if (x.is(Text)) x.state.value.set("x2");
    a.doc.forceCommit();
    x.delete();
    a.doc.forceCommit();
    deliver(b, take(a));
    deliver(b, [insertX!]);
    expect(tree(b)).toBe("root");
    expect(JSON.stringify(b.doc.toJSON()[9])).not.toContain("x2");
  });
});

describe("many children", () => {
  test("children put first one by one keep their order, also after all leave", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    for (let i = 0; i < 200; i++) {
      const node = a.doc.createNode(Text);
      node.state.value.set(`${i}`);
      a.doc.root.prepend(node);
      a.doc.forceCommit();
      deliver(b, take(a));
    }
    expectSameTree(a, b);
    a.doc.root.first!.to(a.doc.root.last!).delete();
    a.doc.forceCommit();
    insert(a, a.doc.root, "x");
    deliver(b, take(a));
    expect(tree(b)).toBe("root(x)");
  });
});

describe("views that a merge rebuilds in several rounds", () => {
  test("a cycle of concurrent moves goes with the node deleted around it", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const d = insert(a, a.doc.root, "d");
    const x = insert(a, d, "x");
    const y = insert(a, d, "y");
    syncAll(a, b);
    x.move(y, "append");
    a.doc.forceCommit();
    b.doc.getNodeById(y.id)!.move(b.doc.getNodeById(x.id)!, "append");
    b.doc.forceCommit();
    syncAll(a, b);
    // The cut keeps both under d, so both were under d when it went.
    a.doc.getNodeById(d.id)!.delete();
    a.doc.forceCommit();
    syncAll(a, b);
    expect(tree(a)).toBe("root");
    expectSameTree(a, b);
  });

  test("a cut node of a later life is affirmed with its life", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const x = insert(a, a.doc.root, "x");
    const y = insert(a, a.doc.root, "y");
    const other = insert(a, a.doc.root, "other");
    syncAll(a, b);
    // y is brought back by an undo: its next moves belong to its second life.
    y.delete();
    a.doc.forceCommit();
    a.doc.undoManager.undo();
    a.doc.forceCommit();
    syncAll(a, b);
    a.doc.getNodeById(x.id)!.move(a.doc.getNodeById(y.id)!, "append");
    a.doc.forceCommit();
    b.doc.getNodeById(y.id)!.move(b.doc.getNodeById(x.id)!, "append");
    b.doc.forceCommit();
    syncAll(a, b);
    expect(a.doc.root.first!.id).toBe(y.id);
    // The next local move affirms where the cut shows y.
    other.move(a.doc.root, "prepend");
    a.doc.forceCommit();
    syncAll(a, b);
    // x leaves y: y stays where it was affirmed on every replica.
    b.doc.getNodeById(x.id)!.move(b.doc.root, "append");
    b.doc.forceCommit();
    syncAll(a, b);
    expectSameTree(a, b);
  });

  test("a node whose new parent is still shown inside it waits for it", () => {
    const [a, b, c] = ["a", "b", "c"].map((peer) => createReplica({ peer }));
    const d = insert(a!, a!.doc.root, "d");
    const p = insert(a!, d, "p");
    const x = insert(a!, a!.doc.root, "x");
    const y = insert(a!, x, "y");
    syncAll(a!, b!, c!);
    // Unseen by b and c: y goes from x to p, and x into y.
    y.move(p, "append");
    a!.doc.forceCommit();
    x.move(y, "append");
    a!.doc.forceCommit();
    // b deletes d, and c takes p out of it, at the same time.
    b!.doc.getNodeById(d.id)!.delete();
    b!.doc.forceCommit();
    c!.doc.getNodeById(p.id)!.move(c!.doc.root, "append");
    c!.doc.forceCommit();
    const [fromB, fromC] = [take(b!), take(c!)];
    deliver(a!, fromB);
    // p is gone here: y falls back to x, which is in y, and the cycle is cut.
    expect(tree(a!)).toBe("root(x(y))");
    deliver(a!, fromC);
    expect(tree(a!)).toBe("root(p(y(x)))");
    deliver(b!, fromC);
    deliver(c!, fromB);
    syncAll(a!, b!, c!);
    expectSameTree(a!, b!, c!);
  });
});

describe("pending descendants", () => {
  test("a local delete keeps the pending of a later life, as a repeat would", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const p = insert(a, a.doc.root, "p");
    const c = insert(a, p, "c");
    const q = insert(a, a.doc.root, "q");
    syncAll(a, b);
    // b deletes c, brings it back with a new life and deletes its parent.
    b.doc.getNodeById(c.id)!.delete();
    b.doc.forceCommit();
    b.doc.undoManager.undo();
    b.doc.forceCommit();
    const lives = take(b);
    b.doc.getNodeById(p.id)!.delete();
    b.doc.forceCommit();
    const parentDelete = take(b);
    // a moved c out meanwhile, hears of the parent's delete, and deletes q.
    c.move(q, "append");
    a.doc.forceCommit();
    deliver(a, parentDelete);
    q.delete();
    a.doc.forceCommit();
    const stored = JSON.stringify(a.doc.toJSON());
    deliver(a, parentDelete);
    expect(JSON.stringify(a.doc.toJSON())).toBe(stored);
    deliver(a, lives);
    syncAll(a, b);
    expectSameTree(a, b);
  });

  test("a local delete keeps the later pointer a remote delete saw", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    const x = insert(a, a.doc.root, "x");
    const p = insert(a, a.doc.root, "p");
    const c = insert(a, p, "c");
    syncAll(a, b);
    // b moves c into x and deletes x: its delete saw c's newer pointer.
    b.doc.getNodeById(c.id)!.move(b.doc.getNodeById(x.id)!, "append");
    b.doc.forceCommit();
    const move = take(b);
    b.doc.getNodeById(x.id)!.delete();
    b.doc.forceCommit();
    // a hears of the delete before the move, and deletes c's parent there.
    deliver(a, take(b));
    p.delete();
    a.doc.forceCommit();
    deliver(a, move);
    syncAll(a, b);
    expectSameTree(a, b);
    expect(tree(a)).toBe("root");
  });
});

describe("records that came broken", () => {
  test("entries that are not lists are skipped, and the rest merges", () => {
    const a = createReplica({ peer: "a" });
    const b = createReplica({ peer: "b" });
    insert(a, a.doc.root, "x");
    // The record is `[3, 0, [[0, [1, "text", 0]]]]` (see engine.test.ts),
    // and the value goes in a row after it, left out here.
    const [head] = take(a)[0]!;
    // Every list of the record gets an entry that is not a list.
    const broken: [number, ...Json[]] = [
      3,
      0,
      [7, [0, 7, [1, "text", 0]]],
      [7],
      [7],
      0,
      [7],
    ];
    deliver(b, [[head, broken]]);
    expect(tree(b)).toBe("root()");
  });
});
