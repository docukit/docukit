import { describe, expect, test } from "vitest";
import { Doc, defineNode, UndoManager } from "@docukit/docnode";
import {
  TextExtension,
  Text,
  text,
  TestExtension,
  TestNode,
  checkUndoManager,
} from "./utils.js";

describe("main.ts coverage", () => {
  // Line 280-282: move with "prepend" position (newPrev = undefined)
  test("move with prepend", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    doc.root.append(...text(doc, "1", "2", "3"));
    const node1 = doc.root.first!;
    const node3 = doc.root.last!;
    node3.move(node1, "prepend");
    expect(node1.first).toBe(node3);
  });

  // Line 394: children().find() with includeSelf: true
  test("children find with includeSelf", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    doc.root.append(...text(doc, "1"));
    const node = doc.root.first!;
    const found = node.children({ includeSelf: true }).find(() => true);
    expect(found).toBe(node);
  });

  // Line 473: descendants().find() with includeSelf: true
  test("descendants find with includeSelf", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    doc.root.append(...text(doc, "1"));
    const node = doc.root.first!;
    const found = node.descendants({ includeSelf: true }).find(() => true);
    expect(found).toBe(node);
  });

  // Line 618: Node without type property
  test("node without type throws", () => {
    expect(() => {
      new Doc({
        extensions: [
          {
            nodes: [
              defineNode({
                type: "", // empty type
                state: {},
              }),
            ],
          },
        ],
      });
    }).toThrowError("Node does not have a type property");
  });

  // Line 659: setState with same value (early return)
  test("setState with same value", () => {
    const doc = new Doc({ extensions: [TextExtension] });
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
});

describe("stateDefinitions.ts coverage", () => {
  test("number and boolean fromJSON not default", () => {
    const doc = new Doc({ extensions: [TestExtension] });
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
  // Lines 67-71: canUndo() and canRedo() returning false
  test("canUndo and canRedo when empty", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const undoManager = new UndoManager(doc);
    expect(undoManager.canUndo()).toBe(false);
    expect(undoManager.canRedo()).toBe(false);
  });

  // Lines 34, 41, 61: UndoManager with max steps and redo
  test("undoManager with operations", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const undoManager = new UndoManager(doc, { maxUndoSteps: 2 });

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
    const doc = new Doc({ extensions: [TextExtension] });
    const undoManager = new UndoManager(doc);

    doc.root.append(...text(doc, "1"));
    doc.forceCommit();

    // No undo yet, so redoStack is empty
    expect(undoManager.canRedo()).toBe(false);
    undoManager.redo(); // Line 61: early return
    expect(doc.root.first).toBeDefined(); // Document unchanged
  });
});

describe("operations.ts coverage", () => {
  // Line 110: ": 0" branch - occurs when deleting and reinserting a node with a single child that has descendants
  test("delete and reinsert node with single child with grandchildren", () => {
    const doc = new Doc({ extensions: [TextExtension] });
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
});

describe("utils.ts coverage", () => {
  // Line 18: detachRange with nodes that have different parents
  test("move range with different parents throws", () => {
    const doc = new Doc({ extensions: [TextExtension] });
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
