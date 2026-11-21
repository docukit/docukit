import { Doc, type Operations } from "@docukit/docnode";
import {
  upgradeOperations,
  type LegacyOperations,
} from "@docukit/docnode/compat";
import { describe, expect, test } from "vitest";
import {
  assertDoc,
  checkUndoManager,
  TestExtension,
  TestNode,
  Text,
  TextExtension,
} from "./utils.js";

/*
 * Batches as `@docukit/docnode` 0.4 wrote them, `[orderedOperations,
 * statePatch]`, for nodes another replica created. Each one is applied after
 * `upgradeOperations`, and must give the document 0.4 gave applying it.
 */

/** A node of the other replica. */
const n = (clock: string) => `Kp3_a0Zx.${clock}`;

/** "a", "b" and "c" under the root, "b" with "b1" and "b2" inside. */
const insertTree: LegacyOperations = [
  [
    [
      0,
      [
        [n("1"), "text"],
        [n("2"), "text"],
        [n("3"), "text"],
      ],
      0,
      0,
      0,
    ],
    [
      0,
      [
        [n("4"), "text"],
        [n("5"), "text"],
      ],
      n("2"),
      0,
      0,
    ],
  ],
  {
    [n("1")]: { value: '"a"' },
    [n("2")]: { value: '"b"' },
    [n("3")]: { value: '"c"' },
    [n("4")]: { value: '"b1"' },
    [n("5")]: { value: '"b2"' },
  },
];

const tree = ["a", "b", "__b1", "__b2", "c"];

const apply = (doc: Doc, legacy: LegacyOperations) => {
  doc.applyOperations(upgradeOperations(legacy));
};

/** Applies `insertTree`, then `legacy` in a transaction of its own. */
const applyOnTree = (legacy: LegacyOperations) => {
  const doc = new Doc({ type: "root", extensions: [TextExtension] });
  checkUndoManager(2, doc, () => {
    apply(doc, insertTree);
    doc.forceCommit();
    apply(doc, legacy);
  });
  return doc;
};

describe("upgradeOperations", () => {
  test("inserts nodes, their children and their state", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      apply(doc, insertTree);
    });
    assertDoc(doc, tree);
  });

  test("inserts between two siblings", () => {
    const doc = applyOnTree([
      [[0, [[n("6"), "text"]], 0, n("1"), n("2")]],
      { [n("6")]: { value: '"ab"' } },
    ]);
    assertDoc(doc, ["a", "ab", "b", "__b1", "__b2", "c"]);
  });

  test("deletes a range of nodes, with their children", () => {
    const doc = applyOnTree([[[1, n("2"), n("3")]], {}]);
    assertDoc(doc, ["a"]);
  });

  test("deletes one node", () => {
    const doc = applyOnTree([[[1, n("4"), 0]], {}]);
    assertDoc(doc, ["a", "b", "__b2", "c"]);
  });

  test("moves a range of nodes", () => {
    const doc = applyOnTree([[[2, n("4"), n("5"), 0, n("3"), 0]], {}]);
    assertDoc(doc, ["a", "b", "c", "b1", "b2"]);
  });

  test("moves one node into another", () => {
    const doc = applyOnTree([[[2, n("1"), 0, n("3"), 0, 0]], {}]);
    assertDoc(doc, ["b", "__b1", "__b2", "c", "__a"]);
  });

  test("sets the state of existing nodes", () => {
    const doc = applyOnTree([
      [],
      { [n("1")]: { value: '"A"' }, [n("5")]: { value: '"B2"' } },
    ]);
    assertDoc(doc, ["A", "b", "__b1", "__B2", "c"]);
  });

  test("applies a batch of every kind in its order", () => {
    const doc = applyOnTree([
      [
        [0, [[n("6"), "text"]], 0, n("3"), 0],
        [2, n("1"), 0, n("2"), n("5"), 0],
        [1, n("4"), 0],
      ],
      { [n("6")]: { value: '"d"' }, [n("3")]: { value: '"C"' } },
    ]);
    assertDoc(doc, ["b", "__b2", "__a", "C", "d"]);
  });

  test("reads every JSON value of the state patch", () => {
    const doc = new Doc({ type: "root", extensions: [TestExtension] });
    apply(doc, [
      [[0, [[n("1"), "test"]], 0, 0, 0]],
      {
        [n("1")]: {
          string: '"x \\"quoted\\""',
          number: "-1.5e3",
          boolean: "1",
          date: '"2020-01-02T00:00:00.000Z"',
        },
      },
    ]);
    const node = doc.root.first;
    expect(node?.is(TestNode)).toBe(true);
    if (!node?.is(TestNode)) return;
    expect(node.state.string.get()).toBe('x "quoted"');
    expect(node.state.number.get()).toBe(-1500);
    expect(node.state.boolean.get()).toBe(true);
    expect(node.state.date.get()).toStrictEqual(
      new Date("2020-01-02T00:00:00.000Z"),
    );
  });

  test("returns a batch in today's format as it is", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const batches: Operations[] = [];
    doc.onChange(({ operations }) => batches.push(operations));
    apply(doc, insertTree);
    doc.forceCommit();
    const own = doc.createNode(Text);
    doc.root.append(own);
    doc.forceCommit();
    // Nodes of another session and of the doc's own: a head of two sessions.
    apply(doc, [[[0, [[n("9"), "text"]], 0, own.id, 0]], {}]);
    doc.forceCommit();
    expect(batches).toHaveLength(3);
    expect(Array.isArray(batches[2]?.[0])).toBe(true);
    for (const batch of batches) expect(upgradeOperations(batch)).toBe(batch);
  });

  test("upgrades an exported undo history", () => {
    const doc = new Doc({
      type: "root",
      extensions: [TextExtension],
      undoManager: { maxUndoSteps: 10, mergeInterval: 0 },
    });
    apply(doc, insertTree);
    doc.forceCommit();
    doc.forceCommit(() => doc.getNodeById(n("2"))?.delete(), {
      skipUndo: true,
    });
    assertDoc(doc, ["a", "c"]);
    // 0.4's history after deleting "b": its undo inserts it back.
    const history = {
      docId: doc.root.id,
      docType: "root",
      undoStack: [
        {
          operations: [
            [
              [0, [[n("2"), "text"]], 0, n("1"), n("3")],
              [
                0,
                [
                  [n("4"), "text"],
                  [n("5"), "text"],
                ],
                n("2"),
                0,
                0,
              ],
            ],
            {
              [n("2")]: { value: '"b"' },
              [n("4")]: { value: '"b1"' },
              [n("5")]: { value: '"b2"' },
            },
          ] satisfies LegacyOperations,
          meta: {},
        },
      ],
      redoStack: [],
    };
    doc.undoManager.importHistory({
      ...history,
      undoStack: history.undoStack.map((item) => ({
        ...item,
        operations: upgradeOperations(item.operations),
      })),
    });
    doc.undoManager.undo();
    doc.forceCommit();
    assertDoc(doc, tree);
  });
});
