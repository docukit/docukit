import { expect, test, describe } from "vitest";
import {
  text,
  assertDoc,
  init,
  Text,
  TextExtension,
  updateAndListen,
  checkUndoManager,
  humanReadableOperations,
  emptyUpdate,
  assertError,
} from "./utils.js";
import {
  type DocNode,
  Doc,
  defineNode,
  UndoManager,
  string,
} from "@docukit/docnode";

//common to all mutators
describe("base", () => {
  test("if node to be attached is from a different doc, should throw", () => {
    const doc1 = new Doc({ extensions: [TextExtension] });
    const doc2 = new Doc({ extensions: [TextExtension] });
    const node1 = doc1.createNode(Text);
    const fn = () => doc2.root.append(node1);
    expect(fn).toThrowError("Node is from a different doc");
  });

  test("if id of node to be attached already exists in the doc, should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const node1 = doc.createNode(Text);
    doc.root.append(node1);
    const fn = () => doc.root.append(node1);
    expect(fn).toThrowError(
      `Node '${node1.id}' cannot be inserted because it already exists in the doc.`,
    );
  });
});

describe("mixed operations", () => {
  test("delete and insert in the same update", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      updateAndListen(
        doc,
        () => {
          const node1 = text(doc, "1").at(0)!;
          doc.root.append(node1);
          node1.delete();
          doc.root.append(node1);
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            operations: [
              "INSERT: undefined --> 1 <-- undefined | PARENT: ROOT",
              "DELETE: from 1 to 1",
              "INSERT: undefined --> 1 <-- undefined | PARENT: ROOT",
              'UPDATE: {"1":{"value":"1"}}',
            ],
            inverseOperations: [
              "DELETE: from 1 to 1",
              "INSERT: undefined --> 1 <-- undefined | PARENT: ROOT",
              "DELETE: from 1 to 1",
            ],
            diff: {
              deleted: {},
              // Note that it appears as inserted and not moved because
              // the insertion was in the same tx, unlike the following
              // tests that use 2 different tx's
              inserted: new Set(["1"]),
              moved: new Set(),
              updated: new Set(),
            },
          });
        },
      );
      assertDoc(doc, ["1"]);
    });
  });

  test("delete and insert in the same update node with children", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(2, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3"));
      const node1 = doc.root.first!;
      node1.append(...text(doc, "1.1", "1.2", "1.3"));
      assertDoc(doc, ["1", "__1.1", "__1.2", "__1.3", "2", "3"]);
      updateAndListen(
        doc,
        () => {
          node1.delete();
          doc.root.append(node1);
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            operations: [
              "DELETE: from 1 to 1",
              "INSERT: 3 --> 1 <-- undefined | PARENT: ROOT",
              "INSERT: undefined --> 1.1 - 1.2 - 1.3 <-- undefined | PARENT: 1",
              'UPDATE: {"1":{"value":"1"},"1.1":{"value":"1.1"},"1.2":{"value":"1.2"},"1.3":{"value":"1.3"}}',
            ],
            inverseOperations: [
              // [#F5LVM] Optimizing to remove the next op is not feasible. Move op is recommended.
              "DELETE: from 1.1 to 1.3",
              "DELETE: from 1 to 1",
              "INSERT: undefined --> 1 <-- 2 | PARENT: ROOT",
              "INSERT: undefined --> 1.1 - 1.2 - 1.3 <-- undefined | PARENT: 1",
              'UPDATE: {"1":{"value":"1"},"1.1":{"value":"1.1"},"1.2":{"value":"1.2"},"1.3":{"value":"1.3"}}',
            ],
            diff: {
              deleted: {},
              inserted: new Set(),
              // [#F5LVM] Optimizing to ["1"] is not feasible.
              // That's why it's recommended to use the move operation.
              moved: new Set(["1", "1.1", "1.2", "1.3"]),
              updated: new Set(["1", "1.1", "1.2", "1.3"]),
            },
          });
        },
      );
      assertDoc(doc, ["2", "3", "1", "__1.1", "__1.2", "__1.3"]);
    });
  });

  test("delete and insert in the same update node with children, do the same with one of the children", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(2, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3"));
      const node1 = doc.root.first!;
      node1.append(...text(doc, "1.1", "1.2", "1.3"));
      assertDoc(doc, ["1", "__1.1", "__1.2", "__1.3", "2", "3"]);
      updateAndListen(
        doc,
        () => {
          node1.delete();
          doc.root.append(node1);
          const node1_1 = node1.first!;
          node1_1.delete();
          node1.append(node1_1);
          assertDoc(doc, ["2", "3", "1", "__1.2", "__1.3", "__1.1"]);
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            operations: [
              "DELETE: from 1 to 1",
              "INSERT: 3 --> 1 <-- undefined | PARENT: ROOT",
              "INSERT: undefined --> 1.1 - 1.2 - 1.3 <-- undefined | PARENT: 1",
              "DELETE: from 1.1 to 1.1",
              "INSERT: 1.3 --> 1.1 <-- undefined | PARENT: 1",
              'UPDATE: {"1":{"value":"1"},"1.2":{"value":"1.2"},"1.3":{"value":"1.3"},"1.1":{"value":"1.1"}}',
            ],
            inverseOperations: [
              "DELETE: from 1.1 to 1.1",
              "INSERT: undefined --> 1.1 <-- 1.2 | PARENT: 1",
              // [#F5LVM] Optimizing to remove the next op is not feasible. Move op is recommended.
              "DELETE: from 1.1 to 1.3",
              "DELETE: from 1 to 1",
              "INSERT: undefined --> 1 <-- 2 | PARENT: ROOT",
              "INSERT: undefined --> 1.1 - 1.2 - 1.3 <-- undefined | PARENT: 1",
              'UPDATE: {"1":{"value":"1"},"1.1":{"value":"1.1"},"1.2":{"value":"1.2"},"1.3":{"value":"1.3"}}',
            ],
            diff: {
              deleted: {},
              inserted: new Set(),
              // [#F5LVM] Optimizing to ["1", "1.1"] is not feasible.
              // That's why it's recommended to use the move operation.
              moved: new Set(["1", "1.1", "1.2", "1.3"]),
              updated: new Set(["1", "1.1", "1.2", "1.3"]),
            },
          });
        },
      );
      assertDoc(doc, ["2", "3", "1", "__1.2", "__1.3", "__1.1"]);
    });
  });

  test("delete and insert in the same update node with grand children", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(2, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3"));
      const node2 = doc.root.first!.next!;
      node2.append(...text(doc, "2.1", "2.2", "2.3"));
      assertDoc(doc, ["1", "2", "__2.1", "__2.2", "__2.3", "3"]);
      const node2_3 = node2.last!;
      node2_3.append(...text(doc, "2.3.1", "2.3.2"));
      assertDoc(doc, [
        "1",
        "2",
        "__2.1",
        "__2.2",
        "__2.3",
        "____2.3.1",
        "____2.3.2",
        "3",
      ]);

      updateAndListen(
        doc,
        () => {
          node2.delete();
          doc.root.prepend(node2);
          assertDoc(doc, [
            "2",
            "__2.1",
            "__2.2",
            "__2.3",
            "____2.3.1",
            "____2.3.2",
            "1",
            "3",
          ]);
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            operations: [
              "DELETE: from 2 to 2",
              "INSERT: undefined --> 2 <-- 1 | PARENT: ROOT",
              "INSERT: undefined --> 2.1 - 2.2 - 2.3 <-- undefined | PARENT: 2",
              "INSERT: undefined --> 2.3.1 - 2.3.2 <-- undefined | PARENT: 2.3",
              'UPDATE: {"2":{"value":"2"},"2.1":{"value":"2.1"},"2.2":{"value":"2.2"},"2.3":{"value":"2.3"},"2.3.1":{"value":"2.3.1"},"2.3.2":{"value":"2.3.2"}}',
            ],
            inverseOperations: [
              // [#F5LVM] Optimizing to remove the next 2 ops is not feasible. Move op is recommended.
              "DELETE: from 2.3.1 to 2.3.2",
              "DELETE: from 2.1 to 2.3",
              "DELETE: from 2 to 2",
              "INSERT: 1 --> 2 <-- 3 | PARENT: ROOT",
              "INSERT: undefined --> 2.1 - 2.2 - 2.3 <-- undefined | PARENT: 2",
              "INSERT: undefined --> 2.3.1 - 2.3.2 <-- undefined | PARENT: 2.3",
              'UPDATE: {"2":{"value":"2"},"2.1":{"value":"2.1"},"2.2":{"value":"2.2"},"2.3":{"value":"2.3"},"2.3.1":{"value":"2.3.1"},"2.3.2":{"value":"2.3.2"}}',
            ],
            diff: {
              deleted: {},
              inserted: new Set(),
              moved: new Set(["2", "2.1", "2.2", "2.3", "2.3.1", "2.3.2"]),
              updated: new Set(["2", "2.1", "2.2", "2.3", "2.3.1", "2.3.2"]),
            },
          });
        },
      );
    });
  });

  test("delete, setState and insert in the same update", () => {
    // Here I use a node with an extra property because I want to
    // test what happens with the unmodified property in patchState.
    const Text2 = defineNode({
      type: "text",
      state: {
        value: string(""),
        value2: string(""),
      },
    });
    const doc = new Doc({ extensions: [{ nodes: [Text2] }] });
    let node1: DocNode<typeof Text2>;
    checkUndoManager(2, doc, () => {
      node1 = doc.createNode(Text2);
      node1.state.value.set("1");
      node1.state.value2.set("value2");
      doc.root.append(node1);

      updateAndListen(
        doc,
        () => {
          node1.delete();
          node1.state.value.set("2");
          doc.root.append(node1);
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            diff: {
              deleted: {},
              inserted: new Set(),
              moved: new Set(["2"]),
              updated: new Set(["2"]),
            },
            inverseOperations: [
              "DELETE: from 2 to 2",
              "INSERT: undefined --> 2 <-- undefined | PARENT: ROOT",
              // [#4GOSK] Theoretically, I could optimize to 'UPDATE: {"2":{"value":"1"}}' if
              // setState wrote eagerly to patchState instead of on insert. The problem
              // would be when trying to insert nodes that were created in a previous tx.
              // It is safer to simply take a snapshot of the full state on insert.
              // Either way, this is a very rare scenario, the normal thing would be to
              // use the move operation.
              'UPDATE: {"2":{"value":"1","value2":"value2"}}',
            ],
            operations: [
              "DELETE: from 2 to 2",
              "INSERT: undefined --> 2 <-- undefined | PARENT: ROOT",
              // Same as the comment above.
              'UPDATE: {"2":{"value":"2","value2":"value2"}}',
            ],
          });
        },
      );
    });
    assertDoc(doc, ["2"]);
  });

  test("setState multiple times in the same update", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(2, doc, () => {
      let node1: DocNode<typeof Text>;
      emptyUpdate(doc, () => {
        node1 = text(doc, "1").at(0)!;
        node1.state.value.set("2");
        node1.state.value.set("3");
      });
      updateAndListen(
        doc,
        () => {
          doc.root.append(node1);
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            operations: [
              "INSERT: undefined --> 3 <-- undefined | PARENT: ROOT",
              'UPDATE: {"3":{"value":"3"}}',
            ],
            inverseOperations: ["DELETE: from 3 to 3"],
            diff: {
              deleted: {},
              inserted: new Set(["3"]),
              moved: new Set(),
              updated: new Set(),
            },
          });
        },
      );
      updateAndListen(
        doc,
        () => {
          node1.state.value.set("4");
          node1.state.value.set("5");
          node1.state.value.set("6");
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            operations: ['UPDATE: {"6":{"value":"6"}}'],
            inverseOperations: ['UPDATE: {"6":{"value":"3"}}'],
            diff: {
              deleted: {},
              inserted: new Set(),
              moved: new Set(),
              updated: new Set(["6"]),
            },
          });
        },
      );
    });
  });

  test("insert, setState multiple times in the same update", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      updateAndListen(
        doc,
        () => {
          const node1 = text(doc, "1").at(0)!;
          doc.root.append(node1);
          node1.state.value.set("2");
          node1.state.value.set("3");
          assertDoc(doc, ["3"]);
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            operations: [
              "INSERT: undefined --> 3 <-- undefined | PARENT: ROOT",
              'UPDATE: {"3":{"value":"3"}}',
            ],
            inverseOperations: ["DELETE: from 3 to 3"],
            diff: {
              deleted: {},
              inserted: new Set(["3"]),
              moved: new Set(),
              updated: new Set(),
            },
          });
        },
      );
    });
  });

  test("delete and insert multiple nodes in different order and position", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      const node1 = doc.createNode(Text);
      const node2 = doc.createNode(Text);
      doc.root.append(node1, node2);
      node1.state.value.set("1");
      node2.state.value.set("2");
      node1.append(...text(doc, "1.1", "1.2", "1.3", "1.4"));
      node2.append(...text(doc, "2.1", "2.2"));
      assertDoc(doc, [
        "1",
        "__1.1",
        "__1.2",
        "__1.3",
        "__1.4",
        "2",
        "__2.1",
        "__2.2",
      ]);
      const node1_2 = node1.first!.next!;
      const node1_3 = node1_2.next!;
      const node1_4 = node1_3.next!;
      node1_2.to(node1_4).delete();
      assertDoc(doc, ["1", "__1.1", "2", "__2.1", "__2.2"]);
      const node2_1 = node2.first!;
      node2_1.insertAfter(node1_4, node1_3, node1_2);

      assertDoc(doc, [
        "1",
        "__1.1",
        "2",
        "__2.1",
        "__1.4",
        "__1.3",
        "__1.2",
        "__2.2",
      ]);
    });
  });
});

describe("append", () => {
  test("to root", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(2, doc, () => {
      doc.root.append(text(doc, "1").at(0)!);
      doc.root.append(text(doc, "2").at(0)!);
      assertDoc(doc, ["1", "2"]);
      doc.forceCommit();
      doc.root.append(text(doc, "3").at(0)!);
      assertDoc(doc, ["1", "2", "3"]);
    });
  });
  test("to non-root node", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(3, doc, () => {
      const node1 = text(doc, "1").at(0)!;
      doc.root.append(node1);
      assertDoc(doc, ["1"]);
      doc.forceCommit();
      node1.append(text(doc, "1.1").at(0)!);
      assertDoc(doc, ["1", "__1.1"]);
      doc.forceCommit();
      node1.append(text(doc, "1.2").at(0)!);
      node1.append(text(doc, "1.3").at(0)!);
      assertDoc(doc, ["1", "__1.1", "__1.2", "__1.3"]);
    });
  });
  test("multiple args", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3"));
      assertDoc(doc, ["1", "2", "3"]);
    });
  });
  test("unattached.append(unattached)", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      let node1: DocNode<typeof Text>;
      emptyUpdate(doc, () => {
        node1 = text(doc, "1").at(0)!;
        const node1_1 = text(doc, "1.1").at(0)!;
        node1.append(node1_1);
      });
      updateAndListen(
        doc,
        () => {
          doc.root.append(node1);
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            operations: [
              "INSERT: undefined --> 1 <-- undefined | PARENT: ROOT",
              "INSERT: undefined --> 1.1 <-- undefined | PARENT: 1",
              'UPDATE: {"1":{"value":"1"},"1.1":{"value":"1.1"}}',
            ],
            inverseOperations: ["DELETE: from 1 to 1"],
            diff: {
              deleted: {},
              inserted: new Set(["1", "1.1"]),
              moved: new Set(),
              updated: new Set(),
            },
          });
        },
      );
      assertDoc(doc, ["1", "__1.1"]);
    });
  });
  test("attached.append(attached) should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3"));
      const node1 = doc.root.first!;
      assertError(
        doc,
        () => {
          const node3 = doc.root.last!;
          node3.append(node1);
        },
        `Node '${node1.id}' cannot be inserted because it already exists in the doc.`,
      );
    });
  });

  test("unattached.append(attached) should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3"));
      const node1 = doc.root.first!;
      assertError(
        doc,
        () => {
          const node4 = text(doc, "4").at(0)!;
          node4.append(node1);
        },
        `Node '${node1.id}' cannot be inserted because it already exists in the doc.`,
      );
    });
  });

  test("zero args", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      emptyUpdate(doc, () => {
        doc.root.append();
      });
      doc.root.append(...text(doc, "1"));
      assertDoc(doc, ["1"]);
    });
  });
  test("append to itself should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      const node = doc.createNode(Text);
      assertError(
        doc,
        () => {
          doc.root.append(node);
          node.append(node);
        },
        `Node '${node.id}' cannot be inserted because it already exists in the doc.`,
      );
    });
  });
});

describe("prepend", () => {
  test("to root", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(2, doc, () => {
      doc.root.prepend(text(doc, "1").at(0)!);
      doc.root.prepend(text(doc, "2").at(0)!);
      doc.forceCommit();
      assertDoc(doc, ["2", "1"]);
      doc.root.prepend(text(doc, "3").at(0)!);
      assertDoc(doc, ["3", "2", "1"]);
    });
  });
  test("to non-root node", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(3, doc, () => {
      const node1 = text(doc, "1").at(0)!;
      doc.root.prepend(node1);
      assertDoc(doc, ["1"]);
      doc.forceCommit();
      node1.prepend(text(doc, "1.1").at(0)!);
      assertDoc(doc, ["1", "__1.1"]);
      doc.forceCommit();
      node1.prepend(text(doc, "1.2").at(0)!);
      node1.prepend(text(doc, "1.3").at(0)!);
      assertDoc(doc, ["1", "__1.3", "__1.2", "__1.1"]);
    });
  });
  test("multiple args", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.prepend(...text(doc, "1", "2", "3"));
      assertDoc(doc, ["1", "2", "3"]);
    });
  });
  test("prepend on an unattached node should work", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      let node1!: DocNode<typeof Text>;
      emptyUpdate(doc, () => {
        node1 = text(doc, "1").at(0)!;
        const node1_1 = text(doc, "1.1").at(0)!;
        node1.prepend(node1_1);
      });
      doc.root.prepend(node1);
      assertDoc(doc, ["1", "__1.1"]);
    });
  });
  // Maybe: This is allowed in DOM API. Should be allowed in DocNode?
  // See mutators.browser.test.ts
  // If this change in the future I should consider adding tests like:
  // - append ancestor
  // - append descendant
  test("prepend on an unattached but one attached node should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.prepend(...text(doc, "1", "2", "3"));
      const node1 = doc.root.first!;
      assertError(
        doc,
        () => {
          const node4 = text(doc, "4").at(0)!;
          node4.prepend(node1);
        },
        `Node '${node1.id}' cannot be inserted because it already exists in the doc.`,
      );
    });
  });
  test("zero args", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      emptyUpdate(doc, () => {
        doc.root.prepend();
      });
      doc.root.prepend(...text(doc, "1"));
      assertDoc(doc, ["1"]);
    });
  });

  test("prepend to itself should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      const node = doc.createNode(Text);
      assertError(
        doc,
        () => {
          doc.root.append(node);
          node.prepend(node);
        },
        `Node '${node.id}' cannot be inserted because it already exists in the doc.`,
      );
    });
  });
  // TO-DECIDE: What happens if I try to append two nodes at once with spread,
  // but one is a child of the other? If they're attached, it gives an error.
  // I already have a test for that, but what if they're not?
});

describe("insertAfter", () => {
  test("multiple nodes", () => {
    init(({ doc, node2 }) => {
      node2.insertAfter(...text(doc, "2.1", "2.2", "2.3"));
      assertDoc(doc, ["1", "2", "2.1", "2.2", "2.3", "3", "4"]);
    });
  });
  test("insert after root should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      assertError(
        doc,
        () => {
          doc.root.insertAfter(...text(doc, "1"));
        },
        "Root node cannot have siblings",
      );
    });
  });
  test("zero args", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      emptyUpdate(doc, () => {
        doc.root.insertAfter();
      });
      assertDoc(doc, []);
    });
  });
  test("insert after itself should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      const node = doc.createNode(Text);
      assertError(
        doc,
        () => {
          doc.root.append(node);
          node.insertAfter(node);
        },
        `Node '${node.id}' cannot be inserted because it already exists in the doc.`,
      );
    });
  });

  test("node.insertAfter(attached) should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3", "4"));
      const node1 = doc.root.first!;
      const node4 = doc.root.last!;
      assertError(
        doc,
        () => {
          node1.insertAfter(node4);
        },
        `Node '${node4.id}' cannot be inserted because it already exists in the doc.`,
      );
    });
  });

  // Maybe: This is allowed in DOM API. Should be allowed in DocNode?
  // See mutators.browser.test.ts
  test("insert after an unattached node should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "1"));
      assertError(
        doc,
        () => {
          const node2 = text(doc, "2").at(0)!;
          const node3 = text(doc, "3").at(0)!;
          node2.insertAfter(node3);
        },
        // TODO: improve error message
        "Cannot read properties of undefined (reading 'id')",
      );
    });
  });
});

describe("insertBefore", () => {
  test("multiple nodes", () => {
    init(({ doc, node2 }) => {
      node2.insertBefore(...text(doc, "1.1", "1.2", "1.3"));
      assertDoc(doc, ["1", "1.1", "1.2", "1.3", "2", "3", "4"]);
    });
  });
  test("insert before root should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      assertError(
        doc,
        () => {
          doc.root.insertBefore(...text(doc, "1"));
        },
        "Root node cannot have siblings",
      );
    });
  });
});

describe("delete", () => {
  test("delete", () => {
    init(({ doc, node1 }) => {
      node1.delete();
      assertDoc(doc, ["2", "3", "4"]);
    });
  });
  test("delete node with grandChildren", () => {
    init(({ doc, node1 }) => {
      node1.append(...text(doc, "1.1", "1.2", "1.3"));
      const _1_2 = node1.first!.next!;
      _1_2.append(...text(doc, "1.2.1", "1.2.2"));
      assertDoc(doc, [
        "1",
        "__1.1",
        "__1.2",
        "____1.2.1",
        "____1.2.2",
        "__1.3",
        "2",
        "3",
        "4",
      ]);
      node1.delete();
      assertDoc(doc, ["2", "3", "4"]);
    });
  });
  test("delete root should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      assertError(
        doc,
        () => {
          doc.root.delete();
        },
        "Root node cannot be deleted",
      );
    });
  });
  test("delete range", () => {
    init(({ doc, node2, node3 }) => {
      node2.to(node3).delete();
      assertDoc(doc, ["1", "4"]);
    });
  });
  // Maybe: this is allowed in DOM API. Should be allowed in DocNode?
  // In DocNode currently it throws an error.
  // test("delete unattached node shouldn't do anything", () => {
  //   const doc = new Doc({ extensions: [TextExtension] });
  //   checkUndoManager(1, doc, () => {
  //     emptyUpdate(doc, () => {
  //       const node = doc.createNode(Text);
  //       node.delete();
  //     });
  //     assertDoc(doc, []);
  //   });
  // });
});

describe("deleteChildren", () => {
  test("deleteChildren", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(2, doc, () => {
      emptyUpdate(doc, () => {
        doc.root.append(...text(doc, "1", "2", "3"));
        assertDoc(doc, ["1", "2", "3"]);
        doc.root.deleteChildren();
        assertDoc(doc, []);
      });
      doc.root.append(...text(doc, "1", "2", "3"));
      const node3 = doc.root.last!;
      node3.append(...text(doc, "3.1", "3.2", "3.3"));
      const node3_2 = node3.first!.next!;
      node3_2.append(...text(doc, "3.2.1", "3.2.2"));
      assertDoc(doc, [
        "1",
        "2",
        "3",
        "__3.1",
        "__3.2",
        "____3.2.1",
        "____3.2.2",
        "__3.3",
      ]);

      doc.forceCommit();
      doc.root.last?.deleteChildren();
      assertDoc(doc, ["1", "2", "3"]);
    });
  });
});

describe("replace", () => {
  test("replace when there is no prevSibling but there is nextSibling", () => {
    init(({ doc, node1 }) => {
      node1.append(...text(doc, "1.1", "1.2", "1.3"));
      const _1_2 = node1.first!.next!;
      _1_2.append(...text(doc, "1.2.1", "1.2.2"));
      assertDoc(doc, [
        "1",
        "__1.1",
        "__1.2",
        "____1.2.1",
        "____1.2.2",
        "__1.3",
        "2",
        "3",
        "4",
      ]);
      const node1New = text(doc, "new1").at(0)!;
      node1New.append(...text(doc, "new1.1", "new1.2"));
      node1.replace(node1New);
      assertDoc(doc, ["new1", "__new1.1", "__new1.2", "2", "3", "4"]);
    });
  });
  test("replace when there is not nextSibling but there is prevSibling", () => {
    init(({ doc, node4 }) => {
      const node4New = text(doc, "new4").at(0)!;
      node4.replace(node4New);
      assertDoc(doc, ["1", "2", "3", "new4"]);
    });
  });

  test("replace when there is no siblings", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(2, doc, () => {
      const node1 = text(doc, "1").at(0)!;
      doc.root.append(node1);
      assertDoc(doc, ["1"]);
      doc.forceCommit();
      const node1New = text(doc, "new1").at(0)!;
      node1.replace(node1New);
      assertDoc(doc, ["new1"]);
    });
  });
  test("replace root should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      assertError(
        doc,
        () => {
          doc.root.replace(text(doc, "newRoot").at(0)!);
        },
        "Root node cannot be deleted",
      );
    });
  });
  test("replace with empty args should delete node", () => {
    init(({ doc, node1 }) => {
      node1.replace();
      assertDoc(doc, ["2", "3", "4"]);
    });
  });
  test("replace with multiple nodes", () => {
    init(({ doc, node1 }) => {
      node1.replace(...text(doc, "new1.1", "new1.2", "new1.3"));
      assertDoc(doc, ["new1.1", "new1.2", "new1.3", "2", "3", "4"]);
    });
  });
  test("replace range", () => {
    init(({ doc, node1 }) => {
      node1.append(...text(doc, "1.1", "1.2", "1.3"));
      const _1_2 = node1.first!.next!;
      _1_2.append(...text(doc, "1.2.1", "1.2.2"));
      assertDoc(doc, [
        "1",
        "__1.1",
        "__1.2",
        "____1.2.1",
        "____1.2.2",
        "__1.3",
        "2",
        "3",
        "4",
      ]);
      const node1New = text(doc, "new1").at(0)!;
      node1New.append(...text(doc, "new1.1", "new1.2"));
      const node3 = node1.next!.next!;
      node1.to(node3).replace(node1New);
      assertDoc(doc, ["new1", "__new1.1", "__new1.2", "4"]);
    });
  });
  test("unattached.replace() should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      assertError(
        doc,
        () => {
          const node1 = text(doc, "1").at(0)!;
          const node1New = text(doc, "new1").at(0)!;
          node1.replace(node1New);
        },
        // TODO: improve error message
        "Cannot read properties of undefined (reading 'id')",
      );
    });
  });
  test.todo("attached.replace(attached2)");
  test.todo("replace with itself");
});

describe("replaceChildren", () => {
  test("empty args should delete all children", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      emptyUpdate(doc, () => {
        doc.root.append(...text(doc, "1", "2", "3"));
        assertDoc(doc, ["1", "2", "3"]);
        doc.root.replaceChildren();
        assertDoc(doc, []);
      });
    });
  });

  test("replaceChildren when node has no children", () => {
    init(({ doc, node1 }) => {
      node1.replaceChildren(...text(doc, "1.1", "1.2", "1.3"));
      assertDoc(doc, ["1", "__1.1", "__1.2", "__1.3", "2", "3", "4"]);
    });
  });

  test("node has grandchildren", () => {
    init(({ doc, node1 }) => {
      node1.append(...text(doc, "1.1", "1.2", "1.3"));
      const _1_2 = node1.first!.next!;
      _1_2.append(...text(doc, "1.2.1", "1.2.2"));
      assertDoc(doc, [
        "1",
        "__1.1",
        "__1.2",
        "____1.2.1",
        "____1.2.2",
        "__1.3",
        "2",
        "3",
        "4",
      ]);
      node1.replaceChildren(...text(doc, "new1.1", "new1.2"));
      assertDoc(doc, ["1", "__new1.1", "__new1.2", "2", "3", "4"]);
    });
  });
});

describe("move", () => {
  test("simple move", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(3, doc, () => {
      doc.root.append(...text(doc, "1", "2"));
      assertDoc(doc, ["1", "2"]);
      doc.forceCommit();
      const undoManager = new UndoManager(doc, { maxUndoSteps: 10 });
      updateAndListen(
        doc,
        () => {
          const node1 = doc.root.first!;
          node1.move(doc.root, "append");
          assertDoc(doc, ["2", "1"]);
        },
        (_changeEvent) => {
          // TODO: assert changeEvent?
        },
      );
      undoManager.undo();
      assertDoc(doc, ["1", "2"]);
    });
  });
  test("move first node as last node", () => {
    init(({ doc, root, node1 }) => {
      node1.move(root, "append");
      assertDoc(doc, ["2", "3", "4", "1"]);
    });
  });

  test("move last node as first node", () => {
    init(({ doc, root, node4 }) => {
      node4.move(root, "prepend");
      assertDoc(doc, ["4", "1", "2", "3"]);
    });
  });

  test("move a range (startNode !== endNode)", () => {
    init(({ doc, root, node1, node2 }) => {
      node1.to(node2).move(root, "append");
      assertDoc(doc, ["3", "4", "1", "2"]);
    });
  });

  test("target is in the range", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3", "4"));
      const node1 = doc.root.first!;
      const node2 = doc.root.first!.next!;
      const node3 = doc.root.first!.next!.next!;
      assertError(
        doc,
        () => {
          node1.to(node3).move(node2, "append");
        },
        "Target is in the range",
      );
      assertError(
        doc,
        () => {
          node1.to(node3).move(node1, "prepend");
        },
        "Target is in the range",
      );
      assertError(
        doc,
        () => {
          node2.to(node3).move(node3, "before");
        },
        "Target is in the range",
      );
    });
  });

  test("target is descendant of the range", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3", "4"));
      const node1 = doc.root.first!;
      const node2 = doc.root.first!.next!;
      const node3 = doc.root.first!.next!.next!;
      node2.append(...text(doc, "2.1", "2.2"));
      const _2_2 = node2.first!.next!;
      _2_2.append(...text(doc, "2.2.1", "2.2.2", "2.2.3"));
      const _2_2_2 = _2_2.first!.next!;
      _2_2_2.append(...text(doc, "2.2.2.1"));
      assertDoc(doc, [
        "1",
        "2",
        "__2.1",
        "__2.2",
        "____2.2.1",
        "____2.2.2",
        "______2.2.2.1",
        "____2.2.3",
        "3",
        "4",
      ]);
      assertError(
        doc,
        () => {
          node1.to(node3).move(_2_2_2, "append");
        },
        "Target is descendant of the range",
      );
      assertError(
        doc,
        () => {
          _2_2_2.move(_2_2_2.first!, "prepend");
        },
        "Target is descendant of the range",
      );
      assertError(
        doc,
        () => {
          _2_2.move(_2_2.first!, "before");
        },
        "Target is descendant of the range",
      );
    });
  });

  test("move to diferent parent", () => {
    init(({ doc, node1, node2 }) => {
      node1.append(...text(doc, "1.1", "1.2"));
      const _1_2 = node1.last!;
      _1_2.move(node2, "append");
      assertDoc(doc, ["1", "__1.1", "2", "__1.2", "3", "4"]);
    });
  });

  test("move to the same position should do nothing", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3", "4"));
      emptyUpdate(doc, () => {
        const node1 = doc.root.first!;
        node1.move(node1.next!, "before");
        assertDoc(doc, ["1", "2", "3", "4"]);
      });
    });
  });

  test("move before or after the root should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    // checkUndoManager(1, doc, () => {
    doc.root.append(...text(doc, "1", "2", "3", "4"));
    const node1 = doc.root.first!;
    assertError(
      doc,
      () => node1.move(doc.root, "before"),
      "You can't move before or after the root",
    );
    assertError(
      doc,
      () => node1.move(doc.root, "after"),
      "You can't move before or after the root",
    );
  });
});

describe("copy", () => {
  test("copy single node", () => {
    init(({ doc, node2, node3 }) => {
      node2.copy(node3, "after");
      assertDoc(doc, ["1", "2", "3", "2", "4"]);
      const node2New = node3.next!;
      expect((node2New as DocNode<typeof Text>).state.value.get()).toBe("2");
      expect(node2New.id).not.toBe(node2.id);
    });
  });
  test("copy single node with descendants", () => {
    init(({ doc, node2, node3 }) => {
      node2.append(...text(doc, "2.1", "2.2", "2.3"));
      const _2_2 = node2.first!.next!;
      _2_2.append(...text(doc, "2.2.1", "2.2.2", "2.2.3"));
      assertDoc(doc, [
        "1",
        "2",
        "__2.1",
        "__2.2",
        "____2.2.1",
        "____2.2.2",
        "____2.2.3",
        "__2.3",
        "3",
        "4",
      ]);
      node2.copy(node3, "append");
      assertDoc(doc, [
        "1",
        "2",
        "__2.1",
        "__2.2",
        "____2.2.1",
        "____2.2.2",
        "____2.2.3",
        "__2.3",
        "3",
        "__2",
        "____2.1",
        "____2.2",
        "______2.2.1",
        "______2.2.2",
        "______2.2.3",
        "____2.3",
        "4",
      ]);
    });
  });
  test("copy to same position should work", () => {
    init(({ doc, node1, node2 }) => {
      node1.copy(doc.root, "prepend");
      node2.copy(node2, "after");
      assertDoc(doc, ["1", "1", "2", "2", "3", "4"]);
    });
  });
  test("copy to descendant should work", () => {
    init(({ doc, node2 }) => {
      node2.append(...text(doc, "2.1", "2.2", "2.3"));
      const _2_2 = node2.first!.next!;
      _2_2.append(...text(doc, "2.2.1", "2.2.2", "2.2.3"));
      assertDoc(doc, [
        "1",
        "2",
        "__2.1",
        "__2.2",
        "____2.2.1",
        "____2.2.2",
        "____2.2.3",
        "__2.3",
        "3",
        "4",
      ]);
      node2.copy(_2_2, "prepend");
      assertDoc(doc, [
        "1",
        "2",
        "__2.1",
        "__2.2",
        "____2",
        "______2.1",
        "______2.2",
        "________2.2.1",
        "________2.2.2",
        "________2.2.3",
        "______2.3",
        "____2.2.1",
        "____2.2.2",
        "____2.2.3",
        "__2.3",
        "3",
        "4",
      ]);
    });
  });
  test("root cannot be copied", () => {
    init(({ doc, root }) => {
      assertError(
        doc,
        () => root.copy(root, "append"),
        "You cannot insert nodes of type 'root'",
      );
    });
  });
  test("copy a range with descendants", () => {
    init(({ doc, node1, node2, node4 }) => {
      node2.append(...text(doc, "2.1", "2.2", "2.3"));
      const _2_2 = node2.first!.next!;
      _2_2.append(...text(doc, "2.2.1", "2.2.2", "2.2.3"));
      assertDoc(doc, [
        "1",
        "2",
        "__2.1",
        "__2.2",
        "____2.2.1",
        "____2.2.2",
        "____2.2.3",
        "__2.3",
        "3",
        "4",
      ]);
      node1.to(node2).copy(node4, "append");
      assertDoc(doc, [
        "1",
        "2",
        "__2.1",
        "__2.2",
        "____2.2.1",
        "____2.2.2",
        "____2.2.3",
        "__2.3",
        "3",
        "4",
        "__1",
        "__2",
        "____2.1",
        "____2.2",
        "______2.2.1",
        "______2.2.2",
        "______2.2.3",
        "____2.3",
      ]);
    });
  });
});

// to + copy/delete/move/replace are tested in the suites of those mutators
describe("to", () => {
  // The error is thrown in the methods and not in "to" because:
  // 1. It is possible to get the "to" range, mutate the document, and then execute the methods
  // 2. performance reasons. One loop only.
  test("if is not a later sibling, should throw", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const { root } = doc;
    checkUndoManager(1, doc, () => {
      root.append(...text(doc, "1", "2", "3", "4"));
      const node1 = root.first!;
      const node3 = node1.next!.next!;
      const range = node3.to(node1);
      const fn = (f: () => void) => {
        assertError(
          doc,
          f,
          `Node '${node1.id}' is not a later sibling of '${node3.id}'`,
        );
      };
      fn(() => range.copy(root, "append"));
      fn(() => range.delete());
      fn(() => range.replace(node1));
      fn(() => range.find(() => void 0));
      fn(() => range.forEach(() => void 0));
      fn(() => range.move(root, "append"));
    });
  });
  test("if is not a later sibling, should throw (different documents)", () => {
    const doc1 = new Doc({ extensions: [TextExtension] });
    const doc2 = new Doc({ extensions: [TextExtension] });
    const node1 = doc1.createNode(Text);
    const node2 = doc2.createNode(Text);
    const range = node1.to(node2);
    const fn = (f: () => void) => {
      assertError(
        doc1,
        f,
        `Node '${node2.id}' is not a later sibling of '${node1.id}'`,
      );
    };
    fn(() => range.copy(doc2.root, "append"));
    fn(() => range.delete());
    fn(() => range.replace(node2));
    fn(() => range.find(() => void 0));
    fn(() => range.forEach(() => void 0));
    fn(() => range.move(doc2.root, "append"));
  });
  test("node to itself should work", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      emptyUpdate(doc, () => {
        let count = 0;
        doc.root.to(doc.root).forEach((node) => {
          expect(node).toBe(doc.root);
          count++;
        });
        expect(count).toBe(1);
      });
    });
  });
  // I could test with unattached nodes, But it is a very rare use case (not a priority).
  // I feel it is reasonable whether it throws an error or not.
});

test("A root node cannot be inserted (there cannot be two root nodes)", () => {
  const RootNode = defineNode({
    type: "docType",
    state: {},
  });
  const doc = new Doc({ extensions: [TextExtension], type: "docType" });
  checkUndoManager(0, doc, () => {
    assertError(
      doc,
      () => {
        doc.createNode(RootNode);
      },
      "You attempted to create a node of type 'docType' with a node definition that was not registered.",
    );
  });

  const doc2 = new Doc({
    extensions: [TextExtension, { nodes: [RootNode] }],
    type: "docType",
  });
  checkUndoManager(0, doc2, () => {
    const root2 = doc2.createNode(RootNode);
    assertError(
      doc2,
      () => {
        doc2.root.append(root2);
      },
      "You cannot insert nodes of type 'root'",
    );
  });
});
