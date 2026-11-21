import { describe, expect, test } from "vitest";
import {
  defineNode,
  Doc,
  type DocNode,
  mergeOperations,
  string,
  _INTERNAL_decodeOperations as decodeOperations,
  type Operations,
  type TransactionFlags,
  type UndoHistory,
} from "@docukit/docnode";
import {
  applyInServerOrder,
  assertDoc,
  checkUndoManager,
  sessionOf,
  short,
  createTextDocWithUndo,
  emptyUpdate,
  humanReadableOperations,
  text,
  Text,
  TextExtension,
  updateAndListen,
  assertError,
} from "./utils.js";

describe("update", () => {
  // TODO: test normalize event too.
  test("Updates that do not mutate the document should not trigger listeners", () => {
    const doc = createTextDocWithUndo();
    checkUndoManager(1, doc, () => {
      emptyUpdate(doc, () => void {});
      emptyUpdate(doc, () => {
        doc.root.append(...text(doc, "1"));
        doc.root.deleteChildren();
      });
      updateAndListen(
        doc,
        () => {
          doc.root.append(...text(doc, "1"));
        },
        () => void {},
      );
      assertDoc(doc, ["1"]);
    });
  });

  test("forceCommit callback commits synchronously with flags", () => {
    const doc = createTextDocWithUndo(10);
    const flags: TransactionFlags[] = [];
    doc.onChange((event) => {
      flags.push(event.flags);
    });

    doc.forceCommit(
      () => {
        doc.root.append(...text(doc, "seed"));
      },
      { skipUndo: true },
    );

    expect(flags).toStrictEqual([{ skipUndo: true }]);
    expect(doc.undoManager.canUndo()).toBe(false);
    expect(() => doc.toJSON()).not.toThrow();

    doc.root.append(...text(doc, "local"));
    doc.forceCommit();

    expect(flags).toStrictEqual([{ skipUndo: true }, {}]);
    expect(doc.undoManager.canUndo()).toBe(true);
  });

  test("forceCommit callback that closes its transaction does not leak flags", () => {
    const doc = createTextDocWithUndo(10);
    const flags: TransactionFlags[] = [];
    doc.onChange((event) => {
      flags.push(event.flags);
    });

    doc.forceCommit(
      () => {
        doc.abort();
      },
      { skipUndo: true },
    );
    doc.root.append(...text(doc, "local"));
    doc.forceCommit();

    expect(flags).toStrictEqual([{}]);
    expect(doc.undoManager.canUndo()).toBe(true);
  });

  test("forceCommit callback is undoable by default", () => {
    const doc = createTextDocWithUndo(10);
    const storedFlags: TransactionFlags[] = [];
    doc.onChange(({ flags }) => {
      storedFlags.push(flags);
    });

    doc.forceCommit(() => {
      doc.root.append(...text(doc, "seed"));
    }, {});

    expect(storedFlags).toStrictEqual([{}]);
    expect(doc.undoManager.canUndo()).toBe(true);
  });

  test("forceCommit callback aborts pending changes when it throws", () => {
    const doc = createTextDocWithUndo(10);
    let changeCount = 0;
    doc.onChange(() => {
      changeCount++;
    });

    expect(() =>
      doc.forceCommit(
        () => {
          doc.root.append(...text(doc, "seed"));
          throw new Error("boom");
        },
        { skipUndo: true },
      ),
    ).toThrowError("boom");

    assertDoc(doc, []);
    expect(changeCount).toBe(0);
    expect(doc.undoManager.canUndo()).toBe(false);
  });

  test("forceCommit callback cannot be nested", () => {
    const doc = createTextDocWithUndo(10);

    expect(() =>
      doc.forceCommit(
        () => {
          doc.root.append(...text(doc, "seed"));
          doc.forceCommit();
        },
        { skipUndo: true },
      ),
    ).toThrowError("You can't call forceCommit inside a forceCommit callback");

    assertDoc(doc, []);
    expect(doc.undoManager.canUndo()).toBe(false);
  });
});

describe("throw errors and abort", () => {
  test("abort should rollback to previous state and not trigger listeners", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const { root } = doc;
    checkUndoManager(0, doc, () => {
      root.append(...text(doc, "1"));
      assertDoc(doc, ["1"]);
      doc.abort();
      assertDoc(doc, []);
    });
  });

  test("should rollback to previous state and not trigger listeners", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const { root } = doc;
    checkUndoManager(2, doc, () => {
      // normal update, no error
      root.append(...text(doc, "1"));

      // Internal error in DocNode operation
      // Rollback full transaction, don't trigger listeners
      assertError(
        doc,
        () => {
          // Making a legitimate operation to check that it is included in the rollback
          root.append(...text(doc, "2"));
          // This should throw - you can't insert after root
          root.insertAfter(...text(doc, "after root"));
        },
        "Root node cannot have siblings",
      );
      assertDoc(doc, ["1"]);

      // External error unrelated to DocNode
      // No rollback. Listeners triggered at the end of the transaction
      let count = 0;
      doc.onChange(() => {
        count++;
      });
      try {
        root.append(...text(doc, "2"));
        throw new Error("external error");
        root.append(...text(doc, "3"));
      } catch (e) {
        assertDoc(doc, ["1", "2"]);
        expect(count).toBe(0);
        doc.forceCommit();
        expect(count).toBe(1);
        expect((e as Error).message).toBe("external error");
      }
      assertDoc(doc, ["1", "2"]);
    });
  });

  test("throw error in change event", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const node = doc.createNode(Text);
    doc.onChange(() => {
      throw new Error("error in change event");
    });
    // checkUndoManager(1, doc, () => {
    doc.root.append(node);
    node.state.value.set("1");
    expect(() => doc.forceCommit()).toThrowError("error in change event");
    expect(1).toBe(1);
  });
});

describe("undoManager", () => {
  function withMockedDateNow(
    callback: (setNow: (value: number) => void) => void,
  ) {
    const originalDateNow = Date.now;
    let now = 0;
    Date.now = () => now;
    try {
      callback((value) => {
        now = value;
      });
    } finally {
      Date.now = originalDateNow;
    }
  }

  test("simplest case", () => {
    const doc = createTextDocWithUndo(1);
    const undoManager = doc.undoManager;
    doc.root.append(...text(doc, "1", "2"));
    assertDoc(doc, ["1", "2"]);
    undoManager.undo();
    assertDoc(doc, []);
    undoManager.redo();
    assertDoc(doc, ["1", "2"]);
  });

  test("maxUndoSteps keeps the most recent undo steps", () => {
    const doc = createTextDocWithUndo(2);
    const undoManager = doc.undoManager;

    checkUndoManager(3, doc, () => {
      doc.root.append(...text(doc, "1"));
      doc.forceCommit();
      doc.root.append(...text(doc, "2"));
      doc.forceCommit();
      doc.root.append(...text(doc, "3"));
      doc.forceCommit();

      expect(undoManager["_undoStack"]).toHaveLength(2);
    });

    // TODO: make checkUndoManager support wrapping undo/redo assertions too.
    undoManager.undo();
    assertDoc(doc, ["1", "2"]);

    undoManager.undo();
    assertDoc(doc, ["1"]);

    undoManager.undo();
    assertDoc(doc, ["1"]);
  });

  test("mergeInterval merges updates separated by a short gap", () => {
    withMockedDateNow((setNow) => {
      const doc = createTextDocWithUndo(10, 500);
      const undoManager = doc.undoManager;

      checkUndoManager(2, doc, () => {
        setNow(1000);
        doc.root.append(...text(doc, "a"));
        doc.forceCommit();
        setNow(1400);
        doc.root.append(...text(doc, "b"));
        doc.forceCommit();

        expect(undoManager["_undoStack"]).toHaveLength(1);
      });

      undoManager.undo();
      assertDoc(doc, []);
      undoManager.redo();
      assertDoc(doc, ["a", "b"]);
    });
  });

  test("mergeInterval starts a new undo step after a long gap", () => {
    withMockedDateNow((setNow) => {
      const doc = createTextDocWithUndo(10, 500);
      const undoManager = doc.undoManager;

      checkUndoManager(2, doc, () => {
        setNow(1000);
        doc.root.append(...text(doc, "a"));
        doc.forceCommit();
        setNow(1600);
        doc.root.append(...text(doc, "b"));
        doc.forceCommit();

        expect(undoManager["_undoStack"]).toHaveLength(2);
      });

      undoManager.undo();
      assertDoc(doc, ["a"]);
      undoManager.undo();
      assertDoc(doc, []);
    });
  });

  test("mergeInterval 0 disables undo step merging", () => {
    withMockedDateNow((setNow) => {
      const doc = createTextDocWithUndo(10, 0);
      const undoManager = doc.undoManager;

      checkUndoManager(2, doc, () => {
        setNow(1000);
        doc.root.append(...text(doc, "a"));
        doc.forceCommit();
        doc.root.append(...text(doc, "b"));
        doc.forceCommit();

        expect(undoManager["_undoStack"]).toHaveLength(2);
      });

      undoManager.undo();
      assertDoc(doc, ["a"]);
    });
  });

  test("exportHistory and importHistory preserve undo, redo, and metadata", () => {
    const source = createTextDocWithUndo();
    let token = 0;
    source.undoManager.onPush(({ meta }) => {
      meta.set("selection", { token: token++ });
    });

    source.root.append(...text(source, "1"));
    source.forceCommit();
    source.root.append(...text(source, "2"));
    source.forceCommit();
    source.undoManager.undo();
    assertDoc(source, ["1"]);

    const history = source.undoManager.exportHistory();
    expect(history.undoStack[0]?.meta).toStrictEqual({
      selection: { token: 0 },
    });
    expect(history.redoStack[0]?.meta).toStrictEqual({
      selection: { token: 2 },
    });

    const replacement = Doc.fromJSON(
      {
        id: source.root.id,
        type: "root",
        extensions: [TextExtension],
        undoManager: { maxUndoSteps: 10, mergeInterval: 0 },
      },
      source.toJSON({ unsafe: true }),
    );
    replacement.forceCommit();
    replacement.undoManager.importHistory(history);

    const restoredMetadata: unknown[] = [];
    replacement.undoManager.onPop(({ meta }) => {
      restoredMetadata.push(meta.get("selection"));
    });

    replacement.undoManager.redo();
    assertDoc(replacement, ["1", "2"]);
    replacement.undoManager.undo();
    assertDoc(replacement, ["1"]);
    replacement.undoManager.undo();
    assertDoc(replacement, []);
    expect(restoredMetadata).toStrictEqual([
      { token: 2 },
      undefined,
      { token: 0 },
    ]);
  });

  test("importHistory preserves the merge interval timestamp", () => {
    withMockedDateNow((setNow) => {
      const source = createTextDocWithUndo(10, 500);
      setNow(1000);
      source.root.append(...text(source, "a"));
      source.forceCommit();

      const history = source.undoManager.exportHistory();
      expect(history.lastUpdate).toBe(1000);

      const replacement = Doc.fromJSON(
        {
          id: source.root.id,
          type: "root",
          extensions: [TextExtension],
          undoManager: { maxUndoSteps: 10, mergeInterval: 500 },
        },
        source.toJSON({ unsafe: true }),
      );
      replacement.forceCommit();
      replacement.undoManager.importHistory(history);

      setNow(1200);
      replacement.root.append(...text(replacement, "b"));
      replacement.forceCommit();
      replacement.undoManager.undo();
      assertDoc(replacement, []);
    });
  });

  test("importHistory validates the history and document identity", () => {
    const source = createTextDocWithUndo();
    source.root.append(...text(source, "1"));
    source.forceCommit();
    const history = source.undoManager.exportHistory();

    expect(() => source.undoManager.importHistory({})).toThrowError(
      "Invalid undo history",
    );

    const otherDoc = createTextDocWithUndo();
    expect(() => otherDoc.undoManager.importHistory(history)).toThrowError(
      "Undo history belongs to a different document",
    );
  });

  test("exportHistory and importHistory clone move operations", () => {
    const doc = createTextDocWithUndo();
    const history: UndoHistory = {
      ...doc.undoManager.exportHistory(),
      undoStack: [{ operations: ["", 2, "start"], meta: {} }],
    };

    doc.undoManager.importHistory(history);

    expect(doc.undoManager.exportHistory().undoStack).toStrictEqual(
      history.undoStack,
    );
  });

  test("importHistory rejects malformed exported history paths", () => {
    const doc = createTextDocWithUndo();
    const valid = doc.undoManager.exportHistory();
    const withOperations = (operations: unknown): unknown => ({
      ...valid,
      undoStack: [{ operations, meta: {} }],
    });

    const malformedHistories: unknown[] = [
      null,
      [],
      new Date(),
      { ...valid, docId: 1 },
      { ...valid, docType: 1 },
      { ...valid, undoStack: null },
      { ...valid, undoStack: [null] },
      { ...valid, undoStack: [{ operations: ["", 1, "a"], meta: [] }] },
      { ...valid, redoStack: null },
      { ...valid, lastUpdate: "now" },
      { ...valid, lastUpdate: Number.NaN },
      withOperations(null),
      withOperations([]),
      withOperations(["s"]),
      // The head: a session, or the sessions of the batch.
      withOperations([1, 1, "a"]),
      withOperations([[], 1, "a"]),
      withOperations([[1], 1, "a"]),
      // Text rows, also one written without its brackets.
      withOperations(["s", 1]),
      withOperations(["s", [1]]),
      withOperations(["s", [null]]),
      withOperations(["s", [[1]]]),
      withOperations(["s", [[]]]),
      // A move to another session and counter.
      withOperations(["s", ["a"], "x"]),
      // Tree rows.
      withOperations(["s", [0]]),
      withOperations(["s", [0, null]]),
      withOperations(["s", [0, [null]]]),
      withOperations(["s", [0, [["id"]]]]),
      withOperations(["s", [0, [["id", 1]]]]),
      withOperations(["s", [0, [["id", "type", "count"]]]]),
      withOperations(["s", [0, [["id", "type"]], null]]),
      withOperations(["s", [0, [], 0, 0, 0, 0]]),
      withOperations(["s", [1, null]]),
      withOperations(["s", [1, "a", "b", "c"]]),
      withOperations(["s", [2, "a", 1.5]]),
      withOperations(["s", [2, "a", 0, 0, 0, 0, 0]]),
      withOperations(["s", [3, "a"]]),
      withOperations(["s", 1]),
      // The state patch, which is the last row.
      withOperations(["s", { a: { value: 1 } }, [1, "a"]]),
      withOperations(["s", { a: 1 }]),
      withOperations(["s", [1, "a"], 5]),
    ];

    for (const malformed of malformedHistories) {
      expect(
        () => doc.undoManager.importHistory(malformed),
        JSON.stringify(malformed),
      ).toThrowError("Invalid undo history");
    }
  });

  test("maxUndoSteps 0 disables undo history", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const undoManager = doc.undoManager;

    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "a"));
      doc.forceCommit();

      expect(undoManager.canUndo()).toBe(false);
    });

    undoManager.undo();
    assertDoc(doc, ["a"]);
  });

  test("merged state patches undo to the state before the first update", () => {
    withMockedDateNow((setNow) => {
      const doc = createTextDocWithUndo(10, 500);
      const undoManager = doc.undoManager;
      let node: DocNode<typeof Text> | undefined;

      checkUndoManager(3, doc, () => {
        setNow(1000);
        doc.forceCommit(() => {
          node = doc.createNode(Text);
          doc.root.append(node);
        }, {});
        if (!node) throw new Error("Expected seed node to be created");

        setNow(1600);
        node.state.value.set("a");
        doc.forceCommit();
        setNow(2000);
        node.state.value.set("b");
        doc.forceCommit();

        expect(undoManager["_undoStack"]).toHaveLength(2);
      });

      undoManager.undo();
      assertDoc(doc, [""]);
    });
  });

  test("mergeOperations combines operations without mutating inputs", () => {
    const first: Operations = [
      "",
      [1, "a"],
      { a: { value: 1 }, b: { value: 2 } },
    ];
    const second: Operations = [
      "",
      [2, "b"],
      { b: { value: 3 }, c: { value: 4 } },
    ];

    const merged = mergeOperations(first, second);

    expect(merged).toStrictEqual([
      "",
      [1, "a"],
      [2, "b"],
      { a: { value: 1 }, b: { value: 3 }, c: { value: 4 } },
    ]);
    expect(first).toStrictEqual([
      "",
      [1, "a"],
      { a: { value: 1 }, b: { value: 2 } },
    ]);
    expect(second).toStrictEqual([
      "",
      [2, "b"],
      { b: { value: 3 }, c: { value: 4 } },
    ]);
  });

  test("undo immediately after a pending local update still undoes that update", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;
    const flags: TransactionFlags[] = [];
    doc.forceCommit();
    const unregister = doc.onChange((event) => {
      flags.push(event.flags);
    });

    doc.root.append(...text(doc, "a"));
    doc.forceCommit();

    doc.root.append(...text(doc, "b"));
    assertDoc(doc, ["a", "b"]);

    undoManager.undo();
    assertDoc(doc, ["a"]);

    undoManager.redo();
    assertDoc(doc, ["a", "b"]);

    unregister();
    expect(flags).toStrictEqual([{}, {}, {}, {}]);
  });

  test("undo/redo - adding and deleting nodes", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;

    // inserte only
    updateAndListen(
      doc,
      () => {
        doc.root.append(...text(doc, "1", "2", "3", "4", "5"));
        doc.root.first?.next?.append(...text(doc, "2.1", "2.2"));
      },
      (changeEvent) => {
        expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
          operations: [
            "INSERT: undefined --> 1 - 2 - 3 - 4 - 5 <-- undefined | PARENT: ROOT",
            "INSERT: undefined --> 2.1 - 2.2 <-- undefined | PARENT: 2",
            'UPDATE: {"1":{"value":"1"},"2":{"value":"2"},"3":{"value":"3"},"4":{"value":"4"},"5":{"value":"5"},"2.1":{"value":"2.1"},"2.2":{"value":"2.2"}}',
          ],
          inverseOperations: ["DELETE: from 1 to 5"],
          diff: {
            deleted: {},
            inserted: new Set(["1", "2", "3", "4", "5", "2.1", "2.2"]),
            moved: new Set(),
            updated: new Set([]),
          },
        });
      },
    );
    const state1 = ["1", "2", "__2.1", "__2.2", "3", "4", "5"];
    assertDoc(doc, state1);

    // insert and delete
    updateAndListen(
      doc,
      () => {
        const node1 = doc.root.first!;
        const node2 = node1.next!;
        const node3 = node2.next!;
        node2.to(node3).delete();
        doc.root.last?.append(...text(doc, "5.1", "5.2", "5.3"));
      },
      (ev) => {
        expect(humanReadableOperations(doc, ev)).toStrictEqual({
          operations: [
            "DELETE: from 2 to 3",
            "INSERT: undefined --> 5.1 - 5.2 - 5.3 <-- undefined | PARENT: 5",
            'UPDATE: {"5.1":{"value":"5.1"},"5.2":{"value":"5.2"},"5.3":{"value":"5.3"}}',
          ],
          inverseOperations: [
            "DELETE: from 5.1 to 5.3",
            "INSERT: 1 --> 2 - 3 <-- 4 | PARENT: ROOT",
            "INSERT: undefined --> 2.1 - 2.2 <-- undefined | PARENT: 2",
            'UPDATE: {"2":{"value":"2"},"3":{"value":"3"},"2.1":{"value":"2.1"},"2.2":{"value":"2.2"}}',
          ],
          diff: {
            deleted: {
              "2": ["text", { value: '"2"' }],
              "2.1": ["text", { value: '"2.1"' }],
              "2.2": ["text", { value: '"2.2"' }],
              "3": ["text", { value: '"3"' }],
            },
            inserted: new Set(["5.1", "5.2", "5.3"]),
            moved: new Set(),
            updated: new Set(),
          },
        });
      },
    );
    const state2 = ["1", "4", "5", "__5.1", "__5.2", "__5.3"];
    assertDoc(doc, state2);

    undoManager.undo();
    assertDoc(doc, state1);
    undoManager.redo();
    assertDoc(doc, state2);
    undoManager.undo();
    assertDoc(doc, state1);
    undoManager.undo();
    assertDoc(doc, []);
    undoManager.redo();
    assertDoc(doc, state1);
    undoManager.redo();
    assertDoc(doc, state2);
  });

  test("Deleting an updated node should not appear in patchState", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const node = doc.createNode(Text);
    doc.root.append(node);
    node.state.value.set("1");

    updateAndListen(
      doc,
      () => {
        node.state.value.set("1 CHANGED");
        node.delete();
      },
      (ev) => {
        expect(humanReadableOperations(doc, ev)).toStrictEqual({
          operations: [
            "DELETE: from 1 CHANGED to 1 CHANGED",
            // What I am testing is that here there is no
            // "UPDATE: {"1":{"value":"1 CHANGED"}}"
          ],
          inverseOperations: [
            "INSERT: undefined --> 1 CHANGED <-- undefined | PARENT: ROOT",
            'UPDATE: {"1 CHANGED":{"value":"1"}}',
          ],
          diff: {
            deleted: { "1 CHANGED": ["text", { value: '"1 CHANGED"' }] },
            inserted: new Set(),
            moved: new Set(),
            updated: new Set(),
          },
        });
      },
    );
  });

  /**
   * TODO:
   * - move nodes?
   * - mutate nested object using spread operator?
   * - mutate nested object using setState?
   * - mutate nested object directly?
   **/
  test("undo/redo - mutating state", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;
    doc.root.append(...text(doc, "1", "2", "3", "4", "5"));
    doc.root.first?.next?.append(...text(doc, "2.1", "2.2"));
    doc.forceCommit();
    const state1 = ["1", "2", "__2.1", "__2.2", "3", "4", "5"];
    assertDoc(doc, state1);

    updateAndListen(
      doc,
      () => {
        const node22 = doc.root.first?.next?.last as DocNode<typeof Text>;
        node22.state.value.set("2.2 CHANGED");
        // TODO: I would like to test with undefined. I need a nullable stateDefinition (see in git history)
        // (doc.root.first?.next?.next?.next as DocNode<typeof Text>).state.value.set(undefined);
        const node4 = doc.root.first?.next?.next?.next as DocNode<typeof Text>;
        node4.state.value.set("4 CHANGED");
      },
      (ev) => {
        expect(humanReadableOperations(doc, ev)).toStrictEqual({
          operations: [
            'UPDATE: {"2.2 CHANGED":{"value":"2.2 CHANGED"},"4 CHANGED":{"value":"4 CHANGED"}}',
          ],
          inverseOperations: [
            'UPDATE: {"2.2 CHANGED":{"value":"2.2"},"4 CHANGED":{"value":"4"}}',
          ],
          diff: {
            deleted: {},
            inserted: new Set(),
            moved: new Set(),
            updated: new Set(["2.2 CHANGED", "4 CHANGED"]),
          },
        });
      },
    );

    const state2 = ["1", "2", "__2.1", "__2.2 CHANGED", "3", "4 CHANGED", "5"];
    assertDoc(doc, state2);
    undoManager.undo();
    assertDoc(doc, state1);
    undoManager.redo();
    assertDoc(doc, state2);
  });

  test.skip("ignore one update", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;
    doc.root.append(...text(doc, "1", "2"));
    doc.forceCommit();
    const one = doc.root.first!;
    one.insertAfter(...text(doc, "1.1"));
    doc.forceCommit();
    const two = one.next!;
    two.insertAfter(...text(doc, "1.2"));
    doc.forceCommit();
    // console.log(
    //   "undoManage.undoStack",
    //   undoManager["undoStack"].map((tx) => serializedTxPayload(tx)),
    // );
    undoManager["_undoStack"].pop();
    //   console.log("undoManage.undoStack", undoManager.undoStack.map((tx)=> serializedTxPayload(tx)));
    assertDoc(doc, ["1", "1.1", "1.2", "2"]);
    undoManager.undo();
    assertDoc(doc, ["1", "2"]);
  });
});

describe("undoManager events", () => {
  test("onPush fires synchronously when an item is added to the undo stack", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;
    const events: { type: "undo" | "redo"; meta: Map<unknown, unknown> }[] = [];
    undoManager.onPush(({ meta, type }) => {
      events.push({ type, meta });
    });

    doc.root.append(...text(doc, "1"));
    doc.forceCommit();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toStrictEqual("undo");
    expect(events[0]?.meta).toBeInstanceOf(Map);
    expect(events[0]?.meta.size).toStrictEqual(0);
  });

  test("onPush fires with type:'redo' when undo pushes to the redo stack", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;
    doc.root.append(...text(doc, "1"));
    doc.forceCommit();

    const types: ("undo" | "redo")[] = [];
    undoManager.onPush(({ type }) => {
      types.push(type);
    });

    undoManager.undo();
    expect(types).toStrictEqual(["redo"]);
  });

  test("onPop fires after undo/redo applies, with the popped meta", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;
    doc.root.append(...text(doc, "1"));
    doc.forceCommit();

    const popped: { type: "undo" | "redo"; meta: Map<unknown, unknown> }[] = [];
    undoManager.onPop(({ meta, type }) => {
      popped.push({ type, meta });
    });

    undoManager.undo();
    expect(popped).toHaveLength(1);
    expect(popped[0]?.type).toStrictEqual("undo");

    undoManager.redo();
    expect(popped).toHaveLength(2);
    expect(popped[1]?.type).toStrictEqual("redo");
  });

  test("binding can attach metadata via meta and read it back on pop", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;

    let counter = 0;
    undoManager.onPush(({ meta }) => {
      meta.set("token", `token-${counter++}`);
    });

    const seenTokens: unknown[] = [];
    undoManager.onPop(({ meta }) => {
      seenTokens.push(meta.get("token"));
    });

    doc.root.append(...text(doc, "1"));
    doc.forceCommit();
    doc.root.append(...text(doc, "2"));
    doc.forceCommit();

    undoManager.undo();
    undoManager.undo();
    expect(seenTokens).toStrictEqual(["token-1", "token-0"]);
  });

  test("the unsubscribe function returned from onPush/onPop removes the handler", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;
    let pushCount = 0;
    const off = undoManager.onPush(() => {
      pushCount++;
    });

    doc.root.append(...text(doc, "1"));
    doc.forceCommit();
    expect(pushCount).toStrictEqual(1);

    off();
    doc.root.append(...text(doc, "2"));
    doc.forceCommit();
    expect(pushCount).toStrictEqual(1);
  });
});

describe("applyOperations", () => {
  function createRemoteInsertOperations(value: string): Operations {
    const source = new Doc({ type: "root", extensions: [TextExtension] });
    let remoteOperations: Operations | undefined;
    updateAndListen(
      source,
      () => {
        source.root.append(...text(source, value));
      },
      (event) => {
        remoteOperations = event.operations;
      },
    );
    if (!remoteOperations) throw new Error("Expected remote operations");
    return remoteOperations;
  }

  function collectFlags(doc: Doc, callback: () => void): TransactionFlags[] {
    const flags: TransactionFlags[] = [];
    doc.forceCommit();
    const unregister = doc.onChange((event) => {
      flags.push(event.flags);
    });
    callback();
    doc.forceCommit();
    unregister();
    return flags;
  }

  test("commits pending update before applying operations and forwards skipUndo", () => {
    const remoteOperations = createRemoteInsertOperations("remote");

    const doc = createTextDocWithUndo();
    const flags = collectFlags(doc, () => {
      doc.root.append(...text(doc, "local"));
      doc.applyOperations(remoteOperations, { skipUndo: true });
    });

    expect(flags).toStrictEqual([{}, { skipUndo: true }]);
    assertDoc(doc, ["local", "remote"]);
    expect(doc.undoManager.canUndo()).toBe(true);
    doc.undoManager.undo();
    assertDoc(doc, ["remote"]);
  });

  test("applyOperations commits pending updates before applying operations", () => {
    const remoteOperations = createRemoteInsertOperations("remote");

    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const flags = collectFlags(doc, () => {
      doc.root.append(...text(doc, "local"));
      doc.applyOperations(remoteOperations);
    });

    expect(flags).toStrictEqual([{}, {}]);
    assertDoc(doc, ["local", "remote"]);
  });

  test("UndoManager ignores applyOperations transactions with skipUndo flag", () => {
    const remoteOperations = createRemoteInsertOperations("remote");

    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;

    doc.applyOperations(remoteOperations, { skipUndo: true });
    expect(undoManager.canUndo()).toBe(false);

    doc.root.append(...text(doc, "local"));
    doc.forceCommit();
    expect(undoManager.canUndo()).toBe(true);
  });

  test("applyOperations plus update are committed as two transactions", () => {
    const remoteOperations = createRemoteInsertOperations("remote");
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const flags = collectFlags(doc, () => {
      doc.applyOperations(remoteOperations, { skipUndo: true });
      doc.root.append(...text(doc, "local"));
    });
    expect(flags).toStrictEqual([{ skipUndo: true }, {}]);
    assertDoc(doc, ["remote", "local"]);
  });

  test("skips inserts of nodes that already exist and applies the rest", () => {
    const doc = createTextDocWithUndo();
    checkUndoManager(2, doc, () => {
      const [existing] = text(doc, "existing");
      const created = doc.createNode(Text);
      doc.root.append(existing!);
      doc.forceCommit();
      doc.applyOperations([
        sessionOf(existing!.id),
        [
          0,
          [
            [short(existing!.id), "text"],
            [short(created.id), "text"],
          ],
        ],
        {
          [short(existing!.id)]: { value: "updated" },
          [short(created.id)]: { value: "created" },
        },
      ]);
      assertDoc(doc, ["updated", "created"]);
      expect(doc.getNodeById(existing!.id)).toBe(existing);
    });
  });

  test("a batch whose inserts all exist still applies its state patch", () => {
    const doc = createTextDocWithUndo();
    checkUndoManager(2, doc, () => {
      const [existing] = text(doc, "existing");
      doc.root.append(existing!);
      doc.forceCommit();
      doc.applyOperations([
        sessionOf(existing!.id),
        [0, [[short(existing!.id), "text"]]],
        { [short(existing!.id)]: { value: "updated" } },
      ]);
      assertDoc(doc, ["updated"]);
    });
  });

  test("rows a batch cannot read are skipped", () => {
    const doc = createTextDocWithUndo();
    const [existing] = text(doc, "existing");
    doc.root.append(existing!);
    doc.forceCommit();
    const id = short(existing!.id);
    // @ts-expect-error - rows that do not match `Operations`
    doc.applyOperations([
      sessionOf(existing!.id),
      [0, 5],
      [1, 5],
      5,
      [0, [5]],
      { [id]: 5 },
    ]);
    doc.forceCommit();
    assertDoc(doc, ["existing"]);
  });

  test("a node id that starts with ! travels escaped", () => {
    let count = 0;
    const config = {
      type: "root",
      extensions: [TextExtension],
      nodeIdGenerator: { generate: () => `!${count++}`, validate: () => true },
    };
    const doc = new Doc(config);
    const replica = Doc.fromJSON({ ...config, id: doc.root.id }, doc.toJSON());
    const batches: Operations[] = [];
    doc.onChange(({ operations }) => batches.push(operations));
    doc.root.append(...text(doc, "a"));
    doc.forceCommit();
    expect(batches).toStrictEqual([
      ["", [0, [["!!1", "text"]]], { "!!1": { value: "a" } }],
    ]);
    replica.applyOperations(batches[0]!);
    replica.forceCommit();
    assertDoc(replica, ["a"]);
  });

  test("a node of the head's session travels by its distance, other ids whole", () => {
    const ids = ["root", "+1", "-x", "s.5", "s.-5", "s.6"];
    let count = 0;
    const config = {
      type: "root",
      extensions: [TextExtension],
      nodeIdGenerator: { generate: () => ids[count++]!, validate: () => true },
    };
    const doc = new Doc(config);
    const replica = Doc.fromJSON({ ...config, id: doc.root.id }, doc.toJSON());
    const batches: Operations[] = [];
    doc.onChange(({ operations }) => batches.push(operations));
    doc.root.append(...text(doc, "a", "b", "c", "d", "e"));
    doc.forceCommit();
    // The head's counter is the first node's clock: "s.5" is `1`, "s.6" `2`.
    // "+1" reads as a distance and is escaped; "-x" does not; "s.-5" is not
    // a clock in base 64.
    const nodes = ["!+1", "-x", 1, ".-5", 2];
    expect(batches).toStrictEqual([
      [
        "s.5",
        [0, nodes.map((node) => [node, "text"])],
        {
          "!+1": { value: "a" },
          "-x": { value: "b" },
          "+1": { value: "c" },
          ".-5": { value: "d" },
          "+2": { value: "e" },
        },
      ],
    ]);
    replica.applyOperations(batches[0]!);
    replica.forceCommit();
    assertDoc(replica, ["a", "b", "c", "d", "e"]);
  });

  test("a tree row that came broken names no node", () => {
    const doc = createTextDocWithUndo();
    const [existing] = text(doc, "existing");
    doc.root.append(existing!);
    doc.forceCommit();
    for (const broken of [
      ["s", [1]],
      ["s", [0, [[".1", 5]]]],
    ] as const)
      expect(() => doc.applyOperations(broken)).not.toThrow();
    assertDoc(doc, ["existing"]);
  });

  test("nodes inserted side by side travel as a run, state as columns", () => {
    const doc = createTextDocWithUndo();
    const start = doc.toJSON();
    const sent: Operations[] = [];
    doc.onChange((event) => sent.push(event.operations));
    doc.root.append(...text(doc, "a", "b", "c", "d"));
    doc.forceCommit();
    expect(JSON.stringify(sent[0])).toContain('*4":{"value":["a","b","c","d"]');
    const replica = Doc.fromJSON(
      { id: doc.root.id, type: "root", extensions: [TextExtension] },
      start,
    );
    replica.applyOperations(sent[0]!);
    replica.forceCommit();
    assertDoc(replica, ["a", "b", "c", "d"]);
    // The undo history keeps the run as it is.
    const reloaded = Doc.fromJSON(
      {
        id: doc.root.id,
        type: "root",
        extensions: [TextExtension],
        undoManager: { maxUndoSteps: 10, mergeInterval: 0 },
      },
      doc.toJSON(),
    );
    reloaded.forceCommit();
    reloaded.undoManager.importHistory(doc.undoManager.exportHistory());
    reloaded.undoManager.undo();
    reloaded.forceCommit();
    assertDoc(reloaded, []);
  });

  test.each(["x*", "a.*"])("ids like %s0 are not read as a run", (prefix) => {
    let clock = 0;
    const doc = new Doc({
      id: "01kc52hq510g6y44jhq0wqrjb3",
      type: "root",
      extensions: [TextExtension],
      nodeIdGenerator: {
        generate: () => `${prefix}${clock++}`,
        validate: () => true,
      },
    });
    doc.forceCommit();
    const start = doc.toJSON();
    const sent: Operations[] = [];
    doc.onChange((event) => sent.push(event.operations));
    doc.root.append(...text(doc, "a", "b", "c"));
    doc.forceCommit();
    const replica = Doc.fromJSON(
      { id: doc.root.id, type: "root", extensions: [TextExtension] },
      start,
    );
    replica.applyOperations(sent[0]!);
    replica.forceCommit();
    assertDoc(replica, ["a", "b", "c"]);
  });

  test("nodes of other sessions or with other keys are not read as a run", () => {
    const Pair = defineNode({
      type: "pair",
      state: { x: string(""), y: string("") },
    });
    const ids = ["a.0", "b.1", "b.2", "b.3"];
    const config = { type: "root", extensions: [{ nodes: [Pair] }] };
    const doc = new Doc({
      ...config,
      id: "01kc52hq510g6y44jhq0wqrjb3",
      nodeIdGenerator: {
        generate: () => ids.shift() ?? "c",
        validate: () => true,
      },
    });
    doc.forceCommit();
    const start = doc.toJSON();
    const sent: Operations[] = [];
    doc.onChange((event) => sent.push(event.operations));
    const pairs = ["1", "2", "3", "4"].map((value, index) => {
      const pair = doc.createNode(Pair);
      // The last one has one key too, but not the same one.
      if (index < 3) pair.state.x.set(value);
      else pair.state.y.set(value);
      return pair;
    });
    doc.root.append(...pairs);
    doc.forceCommit();
    const replica = Doc.fromJSON({ ...config, id: doc.root.id }, start);
    for (const operations of sent) replica.applyOperations(operations);
    replica.forceCommit();
    expect(replica.toJSON()).toStrictEqual(doc.toJSON());
  });

  test("an empty state patch decodes as no state", () => {
    expect(decodeOperations(["s", [1, "a"], {}])).toStrictEqual([
      [[1, "a", 0]],
      {},
    ]);
  });

  test("ids whose clock is not in base 64 travel whole", () => {
    const ids = ["a.é0", "a.é1", "a.é2"];
    const config = { type: "root", extensions: [TextExtension] };
    const doc = new Doc({
      ...config,
      id: "01kc52hq510g6y44jhq0wqrjb3",
      nodeIdGenerator: {
        generate: () => ids.shift() ?? "z.0",
        validate: () => true,
      },
    });
    doc.forceCommit();
    const start = doc.toJSON();
    const sent: Operations[] = [];
    doc.onChange((event) => sent.push(event.operations));
    doc.root.append(...text(doc, "a", "b", "c"));
    doc.forceCommit();
    const replica = Doc.fromJSON({ ...config, id: doc.root.id }, start);
    for (const operations of sent) replica.applyOperations(operations);
    replica.forceCommit();
    expect(replica.toJSON()).toStrictEqual(doc.toJSON());
  });

  test("a batch of many sessions names each of them once", () => {
    const ids = Array.from({ length: 12 }, (_, index) => `s${index}.0`);
    const config = { type: "root", extensions: [TextExtension] };
    const doc = new Doc({
      ...config,
      id: "01kc52hq510g6y44jhq0wqrjb3",
      nodeIdGenerator: {
        generate: () => ids.shift() ?? "z.0",
        validate: () => true,
      },
    });
    doc.forceCommit();
    const start = doc.toJSON();
    const sent: Operations[] = [];
    doc.onChange((event) => sent.push(event.operations));
    const values = ids.map(String);
    doc.root.append(...text(doc, ...values));
    doc.forceCommit();
    const [batch = ["", {}]] = sent;
    expect(batch[0]).toHaveLength(12);
    const replica = Doc.fromJSON({ ...config, id: doc.root.id }, start);
    replica.applyOperations(batch);
    replica.forceCommit();
    assertDoc(replica, values);
  });

  test("a row of an unknown kind is skipped", () => {
    const doc = createTextDocWithUndo();
    const nodes = text(doc, "a");
    doc.root.append(...nodes);
    doc.forceCommit();
    const id = nodes[0]?.id ?? "";
    doc.applyOperations([`${sessionOf(id)}.-`, [9, "x"], [1, short(id)]]);
    doc.forceCommit();
    assertDoc(doc, []);
  });

  test("a run of state that came broken writes nothing", () => {
    const doc = createTextDocWithUndo();
    const [existing] = text(doc, "existing");
    doc.root.append(existing!);
    doc.forceCommit();
    expect(() =>
      doc.applyOperations(["s", { ".1*2": { value: 3 } }]),
    ).not.toThrow();
    assertDoc(doc, ["existing"]);
  });

  test("an operation that cannot be created still aborts the batch silently", () => {
    const doc = createTextDocWithUndo();
    const [existing] = text(doc, "existing");
    doc.root.append(existing!);
    doc.forceCommit();
    const id = doc.createNode(Text).id;
    expect(() =>
      doc.applyOperations([
        sessionOf(id),
        [0, [[short(id), "unregistered"]]],
        { [short(existing!.id)]: { value: "updated" } },
      ]),
    ).not.toThrow();
    assertDoc(doc, ["existing"]);
  });

  test("an undo step made redundant by an excluded change is skipped without breaking history", () => {
    const doc = createTextDocWithUndo();
    const [trash, other] = text(doc, "Trash", "other");
    doc.forceCommit(() => doc.root.append(trash!, other!), { skipUndo: true });
    trash!.delete();
    doc.forceCommit();
    doc.forceCommit(() => doc.root.append(trash!), { skipUndo: true });
    doc.undoManager.undo();
    assertDoc(doc, ["other", "Trash"]);
    expect(doc.undoManager.canUndo()).toBe(false);
    expect(doc.undoManager.canRedo()).toBe(false);
    other!.state.value.set("edited");
    doc.forceCommit();
    // The undo that changed nothing must not leave the manager in undo mode.
    expect(doc.undoManager.canUndo()).toBe(true);
    expect(doc.undoManager.canRedo()).toBe(false);
    doc.undoManager.undo();
    assertDoc(doc, ["other", "Trash"]);
  });

  test("a redo step made redundant by an excluded change is skipped without breaking history", () => {
    const doc = createTextDocWithUndo();
    const [node] = text(doc, "node");
    doc.forceCommit(() => doc.root.append(node!), { skipUndo: true });
    node!.delete();
    doc.forceCommit();
    doc.undoManager.undo();
    assertDoc(doc, ["node"]);
    doc.forceCommit(() => node!.delete(), { skipUndo: true });
    doc.undoManager.redo();
    assertDoc(doc, []);
    expect(doc.undoManager.canRedo()).toBe(false);
    doc.root.append(...text(doc, "next"));
    doc.forceCommit();
    expect(doc.undoManager.canUndo()).toBe(true);
    expect(doc.undoManager.canRedo()).toBe(false);
  });
});

describe("change", () => {
  test("Can't trigger an update inside a change event", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const node = doc.createNode(Text);

    const assertMutation = (i: string, fn: () => void) => {
      let count = 0;
      doc.forceCommit();
      doc.onChange(() => {
        count++;
        expect(fn).toThrowError("You can't trigger an update inside a change");
      });
      node.state.value.set((current) => String(Number(current) + 1));
      doc.forceCommit();
      expect(count).toBe(1);
      assertDoc(doc, [i]);
    };

    checkUndoManager(19, doc, () => {
      node.state.value.set("0");
      doc.root.append(node);

      assertMutation("1", () => doc.root.append(...text(doc, "5")));
      assertMutation("2", () => node.state.value.set("foo"));
      assertMutation("3", () => node.append(...text(doc, "1")));
      assertMutation("4", () => node.prepend(...text(doc, "1")));
      assertMutation("5", () => node.insertAfter(...text(doc, "1")));
      assertMutation("6", () => node.insertBefore(...text(doc, "1")));
      assertMutation("7", () => node.delete());
      assertMutation("8", () => node.deleteChildren());
      assertMutation("9", () => node.replace(...text(doc, "1")));
      assertMutation("10", () => node.replaceChildren(...text(doc, "1")));
      assertMutation("11", () => node.move(node, "append"));
      assertMutation("12", () => node.copy(node, "append"));
      assertMutation("13", () => node.to(node).delete());
      assertMutation("14", () => node.to(node).replace());
      assertMutation("15", () => node.to(node).copy(doc.root, "append"));
      assertMutation("16", () => node.to(node).move(doc.root, "append"));
      assertMutation("17", () => doc.forceCommit());
      assertMutation("18", () => doc.applyOperations([""]));
    });
  });

  test("read only methods don't trigger a change event", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const node = doc.createNode(Text);

    const assertReadOnly = (i: string, fn: () => void) => {
      let count = 0;
      doc.forceCommit();
      doc.onChange(() => {
        count++;
        expect(fn).not.toThrowError();
      });
      // this does not trigger a change because nothing is mutated
      fn();
      doc.forceCommit();
      // I make a real Tx because I want to test that the
      // read only method can be used in change event
      node.state.value.set((current) => String(Number(current) + 1));
      doc.forceCommit();
      expect(count).toBe(1);
      assertDoc(doc, [i]);
    };

    checkUndoManager(18, doc, () => {
      node.state.value.set("0");
      doc.root.append(node);

      // Note: getPrev is a rare case. It should be used only with
      // nodes that were updated in the same transaction, but can be
      // used also in normalize and change events.

      assertReadOnly("1", () => node.id);
      assertReadOnly("2", () => node.type);
      assertReadOnly("3", () => node.parent);
      assertReadOnly("4", () => node.prev);
      assertReadOnly("5", () => node.next);
      assertReadOnly("6", () => node.first);
      assertReadOnly("7", () => node.last);
      assertReadOnly("8", () => node.doc);
      assertReadOnly("9", () => node.state.value.get());
      assertReadOnly("10", () => node.is(Text));
      assertReadOnly("11", () => node.descendants());
      assertReadOnly("12", () => node.ancestors());
      assertReadOnly("13", () => node.prevSiblings());
      assertReadOnly("14", () => node.nextSiblings());
      assertReadOnly("15", () => node.children());
      assertReadOnly("16", () => node.to(node));
      assertReadOnly("17", () => node.to(node).forEach(() => void 0));
    });
  });

  test("Can't register a change event inside a change event", async () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });

    const errorP = new Promise<never>((_, reject) => {
      doc.onChange(() => {
        try {
          doc.onChange(() => void {});
        } catch (e) {
          reject(e as Error);
        }
      });
    });
    doc.root.append(...text(doc, "1", "2", "3", "4"));

    await expect(errorP).rejects.toThrowError(
      "You can't register a change event listener during the change stage",
    );
  });

  // remove event listener
  // changeEvent (operations, inverseOperations, diff)
});

describe("diff", () => {
  test("diff.updated shouldn't include nodes that were inserted in the same transaction", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      updateAndListen(
        doc,
        () => {
          const node = doc.createNode(Text);
          doc.root.append(node);
          node.state.value.set("1");
        },
        (ev) => {
          expect(humanReadableOperations(doc, ev)).toStrictEqual({
            diff: {
              deleted: {},
              inserted: new Set(["1"]),
              moved: new Set(),
              updated: new Set(),
            },
            inverseOperations: ["DELETE: from 1 to 1"],
            operations: [
              "INSERT: undefined --> 1 <-- undefined | PARENT: ROOT",
              'UPDATE: {"1":{"value":"1"}}',
            ],
          });
        },
      );
    });
  });

  test("a node can be in diff.updated and diff.moved at the same time", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    checkUndoManager(2, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3"));
      updateAndListen(
        doc,
        () => {
          const node1 = doc.root.first! as DocNode<typeof Text>;
          node1.state.value.set("1 CHANGED");
          node1.move(doc.root.last!, "append");
          assertDoc(doc, ["2", "3", "__1 CHANGED"]);
        },
        (ev) => {
          expect(humanReadableOperations(doc, ev)).toStrictEqual({
            diff: {
              deleted: {},
              inserted: new Set(),
              moved: new Set(["1 CHANGED"]),
              updated: new Set(["1 CHANGED"]),
            },
            inverseOperations: [
              "MOVE: 1 CHANGED - 1 CHANGED | Parent: ROOT | Prev: undefined | Next: 2",
              'UPDATE: {"1 CHANGED":{"value":"1"}}',
            ],
            operations: [
              "MOVE: 1 CHANGED - 1 CHANGED | Parent: 3 | Prev: undefined | Next: undefined",
              'UPDATE: {"1 CHANGED":{"value":"1 CHANGED"}}',
            ],
          });
        },
      );
    });
  });
});

describe("batching", () => {
  test("batch updates", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const logOp: string[] = [];
    doc.onChange(() => {
      logOp.push("change");
    });
    doc.root.append(...text(doc, "1"));
    logOp.push("update1");
    expect(logOp).toStrictEqual(["update1"]); // without batching should be ["update1","change"]
    doc.root.append(...text(doc, "2"));
    logOp.push("update2");
    expect(logOp).toStrictEqual(["update1", "update2"]);
    void Promise.resolve().then(() => {
      expect(logOp).toStrictEqual(["update1", "update2", "change"]);
    });
    expect(logOp).toStrictEqual(["update1", "update2"]);
    setTimeout(() => {
      expect(logOp).toStrictEqual(["update1", "update2", "change"]);
    }, 0);
  });

  test("batch updates - queueMicrotask", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const logOp: string[] = [];
    doc.onChange(() => {
      logOp.push("change");
    });
    doc.root.append(...text(doc, "1"));
    logOp.push("update1");
    queueMicrotask(() => {
      expect(logOp).toStrictEqual(["update1", "change"]);
    });
    expect(logOp).toStrictEqual(["update1"]);
  });

  test("batch updates - await", async () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const logOp: string[] = [];
    doc.onChange(() => {
      logOp.push("change");
    });
    doc.root.append(...text(doc, "1"));
    logOp.push("update1");
    doc.forceCommit();
    expect(logOp).toStrictEqual(["update1", "change"]);
    doc.root.append(...text(doc, "2"));
    logOp.push("update2");
    await Promise.resolve();
    expect(logOp).toStrictEqual(["update1", "change", "update2", "change"]);
  });
});

describe("a move whose anchors were deleted concurrently", () => {
  const config = { type: "root", extensions: [TextExtension] };
  const initial = (...values: string[]) => {
    const doc = new Doc(config);
    doc.root.append(...text(doc, ...values));
    doc.forceCommit();
    return doc;
  };
  const byValue = (target: Doc, value: string) =>
    target.root
      .descendants()
      .find((node) => node.is(Text) && node.state.value.get() === value)!;

  test("lands before its next sibling when the previous one is gone", () => {
    const { server, replicas } = applyInServerOrder(
      config,
      initial("1", "2", "3", "4"),
      (replica) => byValue(replica, "2").delete(),
      (replica) => byValue(replica, "4").move(byValue(replica, "2"), "after"),
    );
    assertDoc(server, ["1", "4", "3"]);
    for (const replica of replicas) assertDoc(replica, ["1", "4", "3"]);
  });

  test("lands at the end of the root when both neighbors are gone", () => {
    const { server } = applyInServerOrder(
      config,
      initial("1", "2", "3", "4", "5"),
      (replica) => byValue(replica, "2").to(byValue(replica, "3")).delete(),
      (replica) => byValue(replica, "1").move(byValue(replica, "2"), "after"),
    );
    assertDoc(server, ["4", "5", "1"]);
  });

  const withChildren = () => {
    const doc = initial("1", "2");
    byValue(doc, "1").append(...text(doc, "1.1", "1.2"));
    doc.forceCommit();
    return doc;
  };

  test("deletes the range when its new parent is gone", () => {
    const { server, replicas } = applyInServerOrder(
      config,
      withChildren(),
      (replica) => byValue(replica, "1").delete(),
      (replica) => byValue(replica, "2").move(byValue(replica, "1.1"), "after"),
    );
    assertDoc(server, []);
    for (const replica of replicas) assertDoc(replica, []);
  });

  test("checks the parent before the siblings", () => {
    // The previous sibling left the parent before the parent was deleted.
    const { server } = applyInServerOrder(
      config,
      withChildren(),
      (replica) => {
        byValue(replica, "1.1").move(byValue(replica, "2"), "after");
        byValue(replica, "1").delete();
      },
      (replica) => byValue(replica, "2").move(byValue(replica, "1.1"), "after"),
    );
    assertDoc(server, ["1.1"]);
  });
});
