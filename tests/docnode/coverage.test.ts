import { describe, expect, test } from "vitest";
import {
  Doc,
  defineNode,
  type Extension,
  type Operations,
} from "@docukit/docnode";
import {
  TextExtension,
  Text,
  text,
  TestExtension,
  TestNode,
  checkUndoManager,
  createTextDocWithUndo,
  assertDoc,
} from "./utils.js";

describe("main.ts coverage", () => {
  // Line 280-282: move with "prepend" position (newPrev = undefined)
  test("move with prepend", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    doc.root.append(...text(doc, "1", "2", "3"));
    const node1 = doc.root.first!;
    const node3 = doc.root.last!;
    node3.move(node1, "prepend");
    expect(node1.first).toBe(node3);
  });

  // Line 394: children().find() with includeSelf: true
  test("children find with includeSelf", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    doc.root.append(...text(doc, "1"));
    const node = doc.root.first!;
    const found = node.children({ includeSelf: true }).find(() => true);
    expect(found).toBe(node);
  });

  // Line 473: descendants().find() with includeSelf: true
  test("descendants find with includeSelf", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    doc.root.append(...text(doc, "1"));
    const node = doc.root.first!;
    const found = node.descendants({ includeSelf: true }).find(() => true);
    expect(found).toBe(node);
  });

  // Line 618: Node without type property
  test("node without type throws", () => {
    expect(() => {
      new Doc({
        type: "root",
        extensions: [
          {
            nodes: [
              defineNode({
                type: "", // empty type
              }),
            ],
          },
        ],
      });
    }).toThrowError("Node does not have a type property");
  });

  // Line 659: setState with same value (early return)
  test("setState with same value", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const node = doc.createNode(Text);
    doc.root.append(node);
    node.state.value.set("hello");
    doc.forceCommit();
    let changeCount = 0;
    doc.onChange(() => changeCount++);
    node.state.value.set("hello"); // same value, should not trigger change
    doc.forceCommit();
    expect(changeCount).toBe(0);
  });

  test("empty applyOperations throws during strict mode second normalize pass", () => {
    const emptyOperations: Operations = [[], {}];
    const TestExtension: Extension = {
      nodes: [Text],
      register: (doc) => {
        doc.onNormalize(() => {
          doc.applyOperations(emptyOperations);
        });
      },
    };

    expect(() => {
      new Doc({ type: "root", extensions: [TestExtension], strictMode: true });
    }).toThrowError(
      "Strict mode has caught an error: normalize listeners are not idempotent. I.e, they should not mutate the document on the second pass.",
    );
  });
});

describe("stateDefinitions.ts coverage", () => {
  test("number and boolean fromJSON not default", () => {
    const doc = new Doc({ type: "root", extensions: [TestExtension] });
    checkUndoManager(2, doc, () => {
      const node = doc.createNode(TestNode);
      doc.root.append(node);
      node.state.number.set(1);
      node.state.boolean.set(true);
      doc.forceCommit();
      node.state.boolean.set(false);
      const json = doc.toJSON({ unsafe: true });
      expect(json).toBeDefined();
    });
  });
});

describe("undoManager.ts coverage", () => {
  test("canUndo and canRedo are false when disabled manager is empty", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const undoManager = doc.undoManager;
    expect(undoManager.isEnabled).toBe(false);
    expect(undoManager.canUndo()).toBe(false);
    expect(undoManager.canRedo()).toBe(false);
  });

  test("canUndo and canRedo are false when enabled manager is empty", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;
    expect(undoManager.isEnabled).toBe(true);
    expect(undoManager.canUndo()).toBe(false);
    expect(undoManager.canRedo()).toBe(false);
  });

  test("empty undo does not turn the next local edit into redo history", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;

    undoManager.undo();
    doc.root.append(...text(doc, "1"));
    doc.forceCommit();

    expect(undoManager.canUndo()).toBe(true);
    expect(undoManager.canRedo()).toBe(false);

    undoManager.redo();
    assertDoc(doc, ["1"]);
  });

  test("disabled undoManager stays inert after edits", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const undoManager = doc.undoManager;
    let pushCount = 0;
    let popCount = 0;

    expect(undoManager.isEnabled).toBe(false);
    expect(doc["_changeListeners"].size).toBe(0);

    const removePushListener = undoManager.onPush(() => {
      pushCount++;
    });
    const removePopListener = undoManager.onPop(() => {
      popCount++;
    });

    doc.root.append(...text(doc, "1"));
    doc.forceCommit();
    const first = doc.root.first;

    expect(undoManager.canUndo()).toBe(false);
    expect(undoManager.canRedo()).toBe(false);

    undoManager.undo();
    expect(doc.root.first).toBe(first);
    expect(undoManager.canUndo()).toBe(false);
    expect(undoManager.canRedo()).toBe(false);

    undoManager.redo();
    expect(doc.root.first).toBe(first);
    expect(undoManager.canUndo()).toBe(false);
    expect(undoManager.canRedo()).toBe(false);
    expect(pushCount).toBe(0);
    expect(popCount).toBe(0);

    removePushListener();
    removePopListener();
  });

  // Lines 34, 41, 61: UndoManager with max steps and redo
  test("undoManager with operations", () => {
    const doc = createTextDocWithUndo(2);
    const undoManager = doc.undoManager;
    expect(undoManager.isEnabled).toBe(true);
    expect(doc["_changeListeners"].size).toBe(1);

    doc.root.append(...text(doc, "1"));
    doc.forceCommit();
    doc.root.append(...text(doc, "2"));
    doc.forceCommit();
    doc.root.append(...text(doc, "3")); // This will exceed maxUndoSteps
    doc.forceCommit();

    expect(undoManager.canUndo()).toBe(true);
    undoManager.undo();
    expect(undoManager.canRedo()).toBe(true);
    undoManager.redo(); // Line 41: txType === "redo"
  });

  // Line 61: redo when redoStack is empty
  test("undoManager redo when empty", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;

    doc.root.append(...text(doc, "1"));
    doc.forceCommit();

    // No undo yet, so redoStack is empty
    expect(undoManager.canRedo()).toBe(false);
    undoManager.redo(); // Line 61: early return
    expect(doc.root.first).toBeDefined(); // Document unchanged
  });

  test("undoManager event listeners can be removed", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;
    let pushCount = 0;
    let popCount = 0;

    const removePushListener = undoManager.onPush(() => {
      pushCount++;
    });
    const removePopListener = undoManager.onPop(() => {
      popCount++;
    });
    removePushListener();
    removePopListener();

    doc.root.append(...text(doc, "1"));
    doc.forceCommit();
    undoManager.undo();

    expect(pushCount).toBe(0);
    expect(popCount).toBe(0);
  });

  test("undoManager emits push and pop listener events", () => {
    const doc = createTextDocWithUndo();
    const undoManager = doc.undoManager;
    const events: string[] = [];

    undoManager.onPush(({ type }) => {
      events.push(`push:${type}`);
    });
    undoManager.onPop(({ type }) => {
      events.push(`pop:${type}`);
    });

    doc.root.append(...text(doc, "1"));
    doc.forceCommit();
    undoManager.undo();
    undoManager.redo();

    expect(events).toStrictEqual([
      "push:undo",
      "push:redo",
      "pop:undo",
      "push:undo",
      "pop:redo",
    ]);
  });

  test("same-microtask updates after fromJSON do not seed undo history", () => {
    const source = new Doc({ type: "root", extensions: [TextExtension] });
    source.root.append(...text(source, "seed"));
    source.forceCommit();

    const doc = Doc.fromJSON(
      {
        type: "root",
        extensions: [TextExtension],
        undoManager: { maxUndoSteps: 10 },
      },
      source.toJSON(),
    );

    doc.root.append(...text(doc, "local"));
    doc.forceCommit();
    expect(doc.undoManager.canUndo()).toBe(false);
    assertDoc(doc, ["seed", "local"]);

    doc.undoManager.undo();
    assertDoc(doc, ["seed", "local"]);

    doc.root.append(...text(doc, "after"));
    doc.forceCommit();
    assertDoc(doc, ["seed", "local", "after"]);
    expect(doc.undoManager.canUndo()).toBe(true);
  });

  test("fromJSON keeps the initial transaction open until forceCommit", () => {
    const source = new Doc({ type: "root", extensions: [TextExtension] });
    source.root.append(...text(source, "seed"));
    source.forceCommit();

    const doc = Doc.fromJSON(
      {
        type: "root",
        extensions: [TextExtension],
        undoManager: { maxUndoSteps: 10 },
      },
      source.toJSON(),
    );

    expect(() => doc.toJSON()).toThrowError(
      "Cannot serialize a document during an active transaction.",
    );

    let changeCount = 0;
    doc.onChange(() => {
      changeCount++;
    });
    doc.root.append(...text(doc, "local"));
    expect(changeCount).toBe(0);

    doc.forceCommit();

    expect(() => doc.toJSON()).not.toThrow();
    expect(changeCount).toBe(1);
    assertDoc(doc, ["seed", "local"]);
  });

  test("fromJSON allows registering onChange before the initial transaction commits", () => {
    const source = new Doc({ type: "root", extensions: [TextExtension] });
    source.root.append(...text(source, "seed"));
    source.forceCommit();

    const doc = Doc.fromJSON(
      {
        type: "root",
        extensions: [TextExtension],
        undoManager: { maxUndoSteps: 10 },
      },
      source.toJSON(),
    );
    let changeCount = 0;
    doc.onChange(() => {
      changeCount++;
    });
    doc.root.append(...text(doc, "local"));
    expect(changeCount).toBe(0);

    doc.forceCommit();

    expect(changeCount).toBe(1);
    assertDoc(doc, ["seed", "local"]);
    expect(doc.undoManager.canUndo()).toBe(false);
  });

  test("same-microtask updates after doc creation do not seed undo history", () => {
    const doc = new Doc({
      type: "root",
      extensions: [TextExtension],
      undoManager: { maxUndoSteps: 10 },
    });

    doc.root.append(...text(doc, "seed"));
    doc.forceCommit();
    expect(doc.undoManager.canUndo()).toBe(false);
    assertDoc(doc, ["seed"]);
    doc.undoManager.undo();
    assertDoc(doc, ["seed"]);

    doc.root.append(...text(doc, "local"));
    doc.forceCommit();
    assertDoc(doc, ["seed", "local"]);
    expect(doc.undoManager.canUndo()).toBe(true);
  });
});

describe("operations.ts coverage", () => {
  // Line 110: ": 0" branch - occurs when deleting and reinserting a node with a single child that has descendants
  test("delete and reinsert node with single child with grandchildren", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    // Create a parent with a SINGLE child that has grandchildren
    const parent = doc.createNode(Text);
    const singleChild = doc.createNode(Text);
    parent.append(singleChild);
    doc.root.append(parent);
    doc.forceCommit();

    // Delete and reinsert in the same transaction
    parent.delete();
    doc.root.append(parent);
    expect(doc.root.first).toBe(parent);
  });

  test("move operation with missing range endpoints is ignored", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const operations: Operations = [[[2, "missing-start", 0, 0, 0, 0]], {}];

    expect(() => doc.applyOperations(operations)).not.toThrow();
  });
});

describe("idGenerator.ts coverage", () => {
  test("custom timestamp id generator includes extractTime errors", () => {
    const thrownValue = { toString: () => "invalid timestamp" };

    expect(() => {
      new Doc({
        type: "root",
        id: "root-id",
        extensions: [TextExtension],
        nodeIdGenerator: {
          generate: () => "root-id",
          validate: () => true,
          extractTime: () => {
            throw new Error("invalid timestamp");
          },
        },
      });
    }).toThrowError(
      "Failed to extract time from root id 'root-id'. invalid timestamp",
    );

    expect(() => {
      new Doc({
        type: "root",
        id: "root-id",
        extensions: [TextExtension],
        nodeIdGenerator: {
          generate: () => "root-id",
          validate: () => true,
          extractTime: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- Covers defensive handling for non-Error throws.
            throw thrownValue;
          },
        },
      });
    }).toThrowError(
      "Failed to extract time from root id 'root-id'. invalid timestamp",
    );
  });
});

describe("utils.ts coverage", () => {
  // Line 18: detachRange with nodes that have different parents
  test("move range with different parents throws", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const parent1 = doc.createNode(Text);
    const parent2 = doc.createNode(Text);
    doc.root.append(parent1, parent2);
    parent1.append(...text(doc, "1", "2"));
    parent2.append(...text(doc, "3"));

    const child1 = parent1.first!;
    const child3 = parent2.first!;

    // Try to create a range from child1 to child3 (different parents)
    // This should fail when detachRange is called
    expect(() => {
      child1.to(child3).delete();
    }).toThrowError("is not a later sibling of");
  });
});
