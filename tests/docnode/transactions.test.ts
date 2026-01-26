import { describe, expect, test } from "vitest";
import { Doc, type DocNode, UndoManager } from "docnode";
import {
  assertDoc,
  checkUndoManager,
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
    const doc = new Doc({ extensions: [TextExtension] });
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
});

describe("throw errors and abort", () => {
  test("abort should rollback to previous state and not trigger listeners", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const { root } = doc;
    checkUndoManager(0, doc, () => {
      root.append(...text(doc, "1"));
      assertDoc(doc, ["1"]);
      doc.abort();
      assertDoc(doc, []);
    });
  });

  test("should rollback to previous state and not trigger listeners", () => {
    const doc = new Doc({ extensions: [TextExtension] });
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
    const doc = new Doc({ extensions: [TextExtension] });
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
  test("simplest case", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const undoManager = new UndoManager(doc, { maxUndoSteps: 1 });
    doc.root.append(...text(doc, "1", "2"));
    assertDoc(doc, ["1", "2"]);
    undoManager.undo();
    assertDoc(doc, []);
    undoManager.redo();
    assertDoc(doc, ["1", "2"]);
  });

  test("undo/redo - adding and deleting nodes", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const undoManager = new UndoManager(doc, { maxUndoSteps: 10 });

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
    const doc = new Doc({ extensions: [TextExtension] });
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
            deleted: {
              "1 CHANGED": ["text", { value: '"1 CHANGED"' }],
            },
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
    const doc = new Doc({ extensions: [TextExtension] });
    const undoManager = new UndoManager(doc, { maxUndoSteps: 10 });
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
    const doc = new Doc({ extensions: [TextExtension] });
    const undoManager = new UndoManager(doc, { maxUndoSteps: 10 });
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

describe.todo("applyOperations", () => {
  // test.todo("move same item concurrently", () => {
});

describe("change", () => {
  test("Can't trigger an update inside a change event", () => {
    const doc = new Doc({ extensions: [TextExtension] });
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
      assertMutation("18", () => doc.applyOperations([[], {}]));
    });
  });

  test("read only methods don't trigger a change event", () => {
    const doc = new Doc({ extensions: [TextExtension] });
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
    const doc = new Doc({ extensions: [TextExtension] });

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
    const doc = new Doc({ extensions: [TextExtension] });
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
    const doc = new Doc({ extensions: [TextExtension] });
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
    const doc = new Doc({ extensions: [TextExtension] });
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
    const doc = new Doc({ extensions: [TextExtension] });
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
    const doc = new Doc({ extensions: [TextExtension] });
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
