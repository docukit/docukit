import { test, expectTypeOf, describe, expect } from "vitest";
import {
  Doc,
  defineNode,
  defineState,
  type DocNode,
  string,
  type DeepImmutable,
  type StateDefinition,
  type NodeDefinition,
} from "@docukit/docnode";
import {
  Text,
  TextExtension,
  checkUndoManager,
  assertJson,
  TestNode,
  emptyUpdate,
  assertError,
  TestExtension,
  updateAndListen,
  humanReadableOperations,
  assertDoc,
  text,
  getPrevError,
} from "./utils.js";

describe("state", () => {
  test("state of DocNode<NodeDefinition> should have the correct type", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const node = doc.createNode(Text);
    expectTypeOf(node.state).toEqualTypeOf<{
      value: {
        set: (value: string | ((prev: string) => string)) => void;
        get: () => string;
        getPrev: () => [changed: boolean, value: string];
      };
    }>();
  });

  test("state should have the correct type", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const node = doc.createNode(Text);
    expectTypeOf(node.state).toEqualTypeOf<{
      value: {
        set: (value: string | ((prev: string) => string)) => void;
        get: () => string;
        getPrev: () => [changed: boolean, value: string];
      };
    }>();
  });

  test("get and set state", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const node = doc.createNode(Text);
    const value = node.state.value.get();
    expect(value).toBe("");
    node.state.value.set("hello");
    expect(node.state.value.get()).toBe("hello");
  });

  test("default value is not JSON serializable", () => {
    const MyNode = defineNode({
      type: "myNode",
      state: {
        value: defineState({
          // BigInt is not JSON serializable
          fromJSON: (json) => (typeof json === "string" ? BigInt(json) : 10n),
          toJSON: (value) => value.toString(),
        }),
      },
    });
    const doc = new Doc({ extensions: [{ nodes: [MyNode] }] });
    checkUndoManager(1, doc, () => {
      const node = doc.createNode(MyNode);
      doc.root.append(node);
      expect(node.state.value.get()).toBe(10n);
      assertJson(doc, ["root", {}, [["myNode", {}]]]);
      node.state.value.set(20n);
      assertJson(doc, ["root", {}, [["myNode", { value: '"20"' }]]]);
      const json = doc.toJSON({ unsafe: true });
      const doc2 = Doc.fromJSON({ extensions: [{ nodes: [MyNode] }] }, json);
      const node2 = doc2.root.first as DocNode<typeof MyNode>;
      expect(node2.state.value.get()).toBe(20n);
      assertJson(doc2, ["root", {}, [["myNode", { value: '"20"' }]]]);
      // setting state to default value again
      node.state.value.set(10n);
      assertJson(doc, ["root", {}, [["myNode", {}]]]);
      const json2 = doc.toJSON({ unsafe: true });
      const doc3 = Doc.fromJSON({ extensions: [{ nodes: [MyNode] }] }, json2);
      const node3 = doc3.root.first as DocNode<typeof MyNode>;
      expect(node3.state.value.get()).toBe(10n);
      assertJson(doc3, ["root", {}, [["myNode", {}]]]);
    });
  });
});

describe("getState", () => {
  test("recently created, not attached yet", () => {
    const doc = new Doc({ extensions: [{ nodes: [TestNode] }] });
    const x1 = doc.createNode(TestNode);
    expect(x1.state.string.get()).toStrictEqual("");
    expect(x1.state.number.get()).toStrictEqual(0);
    expect(x1.state.boolean.get()).toStrictEqual(false);
    expect(x1.state.date.get()).toStrictEqual(new Date(0));
  });
  test("after setState", () => {
    const doc = new Doc({ extensions: [{ nodes: [TestNode] }] });
    const x1 = doc.createNode(TestNode);
    x1.state.string.set("foo");
    expect(x1.state.string.get()).toStrictEqual("foo");
    doc.root.append(x1);
    expect(x1.state.string.get()).toStrictEqual("foo");
    expect(x1.state.string.get()).toStrictEqual("foo");
  });
  test("in normalize and change events", () => {
    const doc = new Doc({
      extensions: [
        { nodes: [TestNode] },
        {
          register: (doc) => {
            doc.onChange(() => {
              expect(stage).toBe(3);
              stage++;
              const x1 = doc.root.first as DocNode<typeof TestNode>;
              expect(x1.state.string.get()).toStrictEqual("baz");
            });
            doc.onNormalize(() => {
              expect(stage).toBe(1);
              stage++;
              const x1 = doc.root.first as DocNode<typeof TestNode>;
              expect(x1.state.string.get()).toStrictEqual("foo");
              x1.state.string.set("bar");
            });
            doc.onNormalize(() => {
              expect(stage).toBe(2);
              stage++;
              const x1 = doc.root.first as DocNode<typeof TestNode>;
              expect(x1.state.string.get()).toStrictEqual("bar");
              x1.state.string.set("baz");
            });
          },
        },
      ],
      strictMode: false,
    });
    let stage = 0;
    checkUndoManager(1, doc, () => {
      const x1 = doc.createNode(TestNode);
      expect(stage).toBe(0);
      stage++;
      x1.state.string.set("foo");
      expect(x1.state.string.get()).toStrictEqual("foo");
      doc.root.append(x1);
      doc.forceCommit();
      expect(stage).toBe(4);
    });
  });
  test("getState returns deep immutable", () => {
    const doc = new Doc({ extensions: [{ nodes: [TestNode] }] });
    const x1 = doc.createNode(TestNode);
    expectTypeOf<keyof typeof x1.state>().toEqualTypeOf<
      "string" | "number" | "boolean" | "date"
    >();
    expectTypeOf(x1.state.date.get()).toEqualTypeOf<DeepImmutable<Date>>();
    expectTypeOf(x1.state.string.get()).toEqualTypeOf<string>();
    const root = doc.root;
    // @ts-expect-error - expected error
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const _testState = root.state.test;
  });
  test("getState extending root", () => {
    const Root2 = defineNode({
      type: "root",
      state: {
        string: string(""),
      },
    });
    const doc = new Doc({ extensions: [{ nodes: [Text, Root2] }] });
    checkUndoManager(1, doc, () => {
      const { root } = doc;
      expect(root.is(Root2)).toBe(true);
      if (root.is(Root2)) {
        root.state.string.get();
        expectTypeOf(root.state.string.get()).toEqualTypeOf<string>();
        // needed for checkUndoManager to not break due to empty snapshot
        root.append(...text(doc, "1"));
        // @ts-expect-error - expected error
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const _fooState = root.state.foo;
        root.state.string.set("foo");
        expect(root.state.string.get()).toBe("foo");
      }
    });
    assertDoc(doc, ["1"]);
    assertJson(doc, [
      "root",
      { string: '"foo"' },
      [["text", { value: '"1"' }]],
    ]);
  });
  test("getState", () => {
    const doc = new Doc({ extensions: [{ nodes: [TestNode] }] });
    const nodeX = doc.createNode(TestNode);
    doc.root.append(nodeX);
    // 1. Default state
    expect(nodeX["_state"]).toStrictEqual({});
    expect(nodeX.state.string.get()).toStrictEqual("");
    expect(nodeX.state.number.get()).toStrictEqual(0);
    expect(nodeX.state.boolean.get()).toStrictEqual(false);
    expect(nodeX.state.date.get()).toStrictEqual(new Date(0));

    // 2. After setting state
    nodeX.state.string.set("foo");
    expect(nodeX.state.string.get()).toStrictEqual("foo");
    expect(nodeX["_state"]).toStrictEqual({ string: "foo" });

    // 3. After setting state to default
    expect(nodeX.state.string.set(""));
    expect(nodeX.state.string.get()).toStrictEqual("");
    // The next line is debatable. But the reason we don't query the default
    // value in setState is because it should be done in toJSON anyway, and
    // therefore this should be faster (although at a memory cost).
    expect(nodeX["_state"]).toStrictEqual({ string: "" }); // instead of {} ?
  });
});

describe("getPrev", () => {
  test("get prev big/mixed test", () => {
    const doc = new Doc({ extensions: [{ nodes: [TestNode] }] });
    checkUndoManager(3, doc, () => {
      const node = doc.createNode(TestNode);
      doc.root.append(node);
      doc.forceCommit();
      expect(node.state.boolean.get()).toStrictEqual(false);
      expect(node.state.number.get()).toStrictEqual(0);
      expect(node.state.date.get()).toStrictEqual(new Date(0));
      expect(node.state.string.get()).toStrictEqual("");

      expect(() => node.state.string.getPrev()).toThrowError(getPrevError);
      expect(() => node.state.number.getPrev()).toThrowError(getPrevError);
      expect(() => node.state.boolean.getPrev()).toThrowError(getPrevError);
      expect(() => node.state.date.getPrev()).toThrowError(getPrevError);

      node.state.string.set("foo");
      node.state.number.set((current) => current + 1);
      node.state.boolean.set(true);
      node.state.date.set(new Date(1));

      expect(node.state.string.getPrev()).toStrictEqual([true, ""]);
      expect(node.state.number.getPrev()).toStrictEqual([true, 0]);
      expect(node.state.boolean.getPrev()).toStrictEqual([true, false]);
      expect(node.state.date.getPrev()).toStrictEqual([true, new Date(0)]);

      node.state.string.set("bar");
      node.state.number.set((current) => current + 1);
      // resetting boolean to false
      node.state.boolean.set(false);
      node.state.date.set(new Date(1));

      expect(node.state.string.getPrev()).toStrictEqual([true, ""]);
      expect(node.state.number.getPrev()).toStrictEqual([true, 0]);
      expect(node.state.boolean.getPrev()).toStrictEqual([false, false]);
      expect(node.state.date.getPrev()).toStrictEqual([true, new Date(0)]);

      doc.forceCommit();

      expect(() => node.state.string.getPrev()).toThrowError(getPrevError);
      expect(() => node.state.number.getPrev()).toThrowError(getPrevError);
      expect(() => node.state.boolean.getPrev()).toThrowError(getPrevError);
      expect(() => node.state.date.getPrev()).toThrowError(getPrevError);

      node.state.string.set("baz");
      node.state.number.set((current) => current + 1);
      // resetting boolean to false
      node.state.boolean.set(false);
      node.state.date.set(new Date(2));

      expect(node.state.string.getPrev()).toStrictEqual([true, "bar"]);
      expect(node.state.number.getPrev()).toStrictEqual([true, 2]);
      expect(node.state.boolean.getPrev()).toStrictEqual([false, false]);
      expect(node.state.date.getPrev()).toStrictEqual([true, new Date(1)]);

      node.state.boolean.set(true);

      expect(node.state.boolean.getPrev()).toStrictEqual([true, false]);
    });
  });

  test("getPrev in idle", () => {
    const doc = new Doc({ extensions: [{ nodes: [Text] }] });
    checkUndoManager(0, doc, () => {
      const node = doc.createNode(Text);
      expect(() => node.state.value.getPrev()).toThrowError(getPrevError);
    });
  });

  test("getPrev in change and normalize", () => {
    const doc = new Doc({
      extensions: [
        {
          nodes: [Text],
          register(doc) {
            doc.onNormalize(() => {
              const node = doc.root.last as DocNode<typeof Text>;
              if (node.state.value.get() === "") {
                expect(() => node.state.value.getPrev()).toThrowError(
                  getPrevError,
                );
              } else {
                expect(node.state.value.getPrev()).toStrictEqual([true, ""]);
              }
            });
            doc.onChange(() => {
              const node = doc.root.last as DocNode<typeof Text>;
              if (node.state.value.get() === "") {
                expect(() => node.state.value.getPrev()).toThrowError(
                  getPrevError,
                );
              } else {
                expect(node.state.value.getPrev()).toStrictEqual([true, ""]);
              }
            });
          },
        },
      ],
    });
    checkUndoManager(2, doc, () => {
      const node = doc.createNode(Text);
      doc.root.append(node);
      doc.forceCommit();
      node.state.value.set("foo");
      expect(node.state.value.getPrev()).toStrictEqual([true, ""]);
      doc.forceCommit();
      expect(() => node.state.value.getPrev()).toThrowError(getPrevError);
    });
  });

  test("unatached node, not yet inserted", () => {
    const doc = new Doc({ extensions: [{ nodes: [Text] }] });
    checkUndoManager(0, doc, () => {
      const node = doc.createNode(Text);
      // I am not sure about this one. "false" may be inaccurate. It has changed
      expect(() => node.state.value.getPrev()).toThrowError(getPrevError);
    });
  });

  test("unatached node, deleted", () => {
    const doc = new Doc({ extensions: [{ nodes: [Text] }] });
    checkUndoManager(2, doc, () => {
      const node = doc.createNode(Text);
      node.state.value.set("foo");
      doc.root.append(node);
      doc.forceCommit();
      node.delete();
      expect(() => node.state.value.getPrev()).toThrowError(getPrevError);
    });
  });

  test("inserted in same transaction", () => {
    const doc = new Doc({ extensions: [{ nodes: [Text] }] });
    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      doc.root.append(node);
      expect(() => node.state.value.getPrev()).toThrowError(getPrevError);
    });
  });

  test("already inserted, not updated", () => {
    const doc = new Doc({ extensions: [{ nodes: [Text] }] });
    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      doc.root.append(node);
      doc.forceCommit();
      expect(() => node.state.value.getPrev()).toThrowError(getPrevError);
    });
  });

  test("already inserted, updated", () => {
    const doc = new Doc({ extensions: [{ nodes: [Text] }] });
    checkUndoManager(2, doc, () => {
      const node = doc.createNode(Text);
      doc.root.append(node);
      doc.forceCommit();
      node.state.value.set("foo");
      expect(node.state.value.getPrev()).toStrictEqual([true, ""]);
    });
  });
});

test("setState should update patchState only if the node is inserted", () => {
  const doc = new Doc({ extensions: [TextExtension] });
  const node = doc.createNode(Text);
  checkUndoManager(2, doc, () => {
    // setting state for a node that is not attached yet
    emptyUpdate(doc, () => {
      node.state.value.set("1");
      expect(doc["_operations"][1]).toStrictEqual({});
    });

    // attaching a node with existing state
    updateAndListen(
      doc,
      () => {
        doc.root.append(node);
        expect(doc["_operations"][1]).toStrictEqual({
          [node.id]: { value: '"1"' },
        });
      },
      (changeEvent) => {
        expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
          operations: [
            "INSERT: undefined --> 1 <-- undefined | PARENT: ROOT",
            'UPDATE: {"1":{"value":"1"}}',
          ],
          inverseOperations: ["DELETE: from 1 to 1"],
          diff: {
            deleted: {},
            inserted: new Set("1"),
            moved: new Set(),
            updated: new Set(),
          },
        });
      },
    );

    // setting state for an attached node
    updateAndListen(
      doc,
      () => {
        node.state.value.set("2");
        expect(doc["_operations"][1]).toStrictEqual({
          [node.id]: { value: '"2"' },
        });
      },
      (changeEvent) => {
        expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
          operations: ['UPDATE: {"2":{"value":"2"}}'],
          inverseOperations: ['UPDATE: {"2":{"value":"1"}}'],
          diff: {
            deleted: {},
            inserted: new Set(),
            moved: new Set(),
            updated: new Set(["2"]),
          },
        });
      },
    );
  });
});

describe("setState", () => {
  test("types error for invalid keys or values, runtime error for invalid keys", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(0, doc, () => {
      const node = doc.createNode(Text);
      emptyUpdate(doc, () => {
        // @ts-expect-error - invalid key
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const fn = () => node.state.foo.set("foo");
        expect(fn).toThrowError(
          "Cannot read properties of undefined (reading 'set')",
        );
        // @ts-expect-error - invalid value
        node.state.value.set(1);
        // @ts-expect-error - stateDefinitions should not accept undefined
        node.state.value.set(undefined);
      });
    });
  });
  test("DocNode without NodeDefinition should not accept unknown keys", () => {
    const doc = new Doc({ extensions: [TestExtension] });
    checkUndoManager(0, doc, () => {
      const unknownNode = doc.root as unknown as DocNode<typeof TestNode>;
      assertError(
        doc,
        () => {
          unknownNode.state.string.set("foo");
        },
        "Cannot read properties of undefined (reading 'set')",
      );
    });
  });

  test("setting state from default value should set default value in inverse operations", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(2, doc, () => {
      const node = doc.createNode(Text);
      doc.root.append(node);
      updateAndListen(
        doc,
        () => {
          node.state.value.set("newValue");
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            operations: ['UPDATE: {"newValue":{"value":"newValue"}}'],
            inverseOperations: ['UPDATE: {"newValue":{"value":""}}'],
            diff: {
              deleted: {},
              inserted: new Set(),
              moved: new Set(),
              updated: new Set(["newValue"]),
            },
          });
        },
      );
    });
  });

  test("setting state from default value should set default value in inverse operations - non-JSON serializable value", () => {
    const MyNode = defineNode({
      type: "myNode",
      state: {
        value: defineState({
          fromJSON: (json) => (typeof json === "string" ? BigInt(json) : 10n),
          toJSON: (value) => value.toString(),
        }),
      },
    });
    const doc = new Doc({ extensions: [{ nodes: [MyNode] }] });
    checkUndoManager(2, doc, () => {
      const node = doc.createNode(MyNode);
      doc.root.append(node);
      updateAndListen(
        doc,
        () => {
          node.state.value.set(20n);
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            operations: ['UPDATE: {"20":{"value":"20"}}'],
            inverseOperations: ['UPDATE: {"20":{"value":"10"}}'],
            diff: {
              deleted: {},
              inserted: new Set(),
              moved: new Set(),
              updated: new Set([20n]),
            },
          });
        },
      );
    });
  });

  test("setting state to undefined when no alternative json serialization was defined should throw", () => {
    const MyNode = defineNode({
      type: "myNode",
      state: {
        value: defineState({
          fromJSON: (json) => {
            if (json === undefined) return "";
            if (json === "undefined") return undefined;
            return typeof json === "string" ? json : "";
          },
        }),
      },
    });

    const MyNode2 = defineNode({
      type: "myNode2",
      state: {
        value: defineState({
          fromJSON: (json) => {
            if (json === undefined) return "";
            if (json === "undefined") return undefined;
            return typeof json === "string" ? json : "";
          },
          toJSON: (value) => {
            if (value === undefined) return "undefined";
            return value;
          },
        }),
      },
    });

    const doc = new Doc({ extensions: [{ nodes: [MyNode, MyNode2] }] });
    checkUndoManager(1, doc, () => {
      const node = doc.createNode(MyNode);
      doc.root.append(node);
      expect(() => node.state.value.set(undefined)).toThrowError(
        "The JSON serialization for state value on a node of type myNode is undefined.",
      );
      const node2 = doc.createNode(MyNode2);
      doc.root.append(node2);
      expect(() => node2.state.value.set(undefined)).not.toThrow();
      expect(node2.state.value.get()).toStrictEqual(undefined);
      assertJson(doc, ["root", {}, [["myNode2", { value: '"undefined"' }]]]);
      const json = doc.toJSON({ unsafe: true });
      const doc2 = Doc.fromJSON(
        { extensions: [{ nodes: [MyNode, MyNode2] }] },
        json,
      );
      const node3 = doc2.root.first as DocNode<typeof MyNode2>;
      expect(node3.state.value.get()).toStrictEqual(undefined);
      assertJson(doc2, ["root", {}, [["myNode2", { value: '"undefined"' }]]]);
    });
  });

  test("setting state to default value", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    let node: DocNode<typeof Text>;
    checkUndoManager(3, doc, () => {
      node = doc.createNode(Text);
      expect(node["_state"]).toStrictEqual({});
      expect(node.state.value.get()).toStrictEqual("");
      doc.root.append(node);

      doc.forceCommit();
      assertJson(doc, ["root", {}, [["text", {}]]]);
      node.state.value.set("foo");
      expect(node["_state"]).toStrictEqual({ value: "foo" });
      expect(node.state.value.get()).toStrictEqual("foo");

      doc.forceCommit();
      assertJson(doc, ["root", {}, [["text", { value: '"foo"' }]]]);
      node.state.value.set("");
      // The next line is debatable. But the reason we don't query the default
      // value in setState is because it should be done in toJSON anyway, and
      // therefore this should be faster (although at a memory cost).
      expect(node["_state"]).toStrictEqual({ value: "" });
      expect(node.state.value.get()).toStrictEqual("");
      assertJson(doc, ["root", {}, [["text", {}]]]);
    });
  });

  test("updater function", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    const node = doc.createNode(Text);
    checkUndoManager(2, doc, () => {
      doc.root.append(node);
      node.state.value.set((current) => current + "changed");
      doc.forceCommit();
      assertDoc(doc, ["changed"]);
      node.state.value.set((current) => current + " - changed2");
      node.state.value.set((current) => current + " - changed3");
      assertDoc(doc, ["changed - changed2 - changed3"]);
    });
    // @ts-expect-error - invalid value
    const _fn = () => node.state.value.set(() => 1);
  });

  test("setting state when default value is undefined", () => {
    const Text2 = defineNode({
      type: "text",
      state: {
        value: defineState({
          fromJSON: (json) => {
            if (json === "_DEFAULT") return undefined;
            return typeof json === "string" ? json : undefined;
          },
          toJSON: (value) => {
            return typeof value === "string" ? value : "_DEFAULT";
          },
        }),
      },
    });
    const doc = new Doc({ extensions: [{ nodes: [Text2] }] });
    checkUndoManager(3, doc, () => {
      const node = doc.createNode(Text2);
      doc.root.append(node);
      expect(node.state.value.get()).toStrictEqual(undefined);
      doc.forceCommit();
      node.state.value.set("foo");
      expect(node.state.value.get()).toStrictEqual("foo");
      doc.forceCommit();
      node.state.value.set("");
      expect(node.state.value.get()).toStrictEqual("");
    });
  });

  test("setting state to prev value should be a no-op", () => {
    const doc = new Doc({ extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      const node = doc.createNode(Text);
      doc.root.append(node);
      node.state.value.set("foo");
      doc.forceCommit();
      node.state.value.set("foo");
      doc.forceCommit();
      node.state.value.set("foo changed");
      expect(doc["_diff"].updated).toStrictEqual(new Set([node.id]));
      node.state.value.set("foo");
      expect(doc["_diff"].updated).toStrictEqual(new Set());
    });
    assertDoc(doc, ["foo"]);
  });

  test("setting state to prev value in real transaction shouldn't include statePatch", () => {
    const doc = new Doc({ extensions: [{ nodes: [TestNode] }] });
    checkUndoManager(2, doc, () => {
      const node = doc.createNode(TestNode);
      doc.root.append(node);
      doc.forceCommit();
      updateAndListen(
        doc,
        () => {
          node.state.boolean.set(true);
          // set string to trigger a transaction
          node.state.string.set("bar");
          node.state.boolean.set(false);
        },
        (changeEvent) => {
          expect(humanReadableOperations(doc, changeEvent)).toStrictEqual({
            diff: {
              deleted: {},
              inserted: new Set(),
              moved: new Set(),
              updated: new Set(['{"string":"\\"bar\\""}']),
            },
            inverseOperations: [
              'UPDATE: {"{\\"string\\":\\"\\\\\\"bar\\\\\\"\\"}":{"string":""}}',
            ],
            operations: [
              'UPDATE: {"{\\"string\\":\\"\\\\\\"bar\\\\\\"\\"}":{"string":"bar"}}',
            ],
          });
        },
      );
    });
  });
});

describe("custom methods", () => {
  const countState = defineState({
    fromJSON: (json) => (typeof json === "number" ? json : 0),
    methods: ({ get, getPrev, set }) => ({
      get,
      getPrev,
      increment: (step = 1) => set((current) => current + step),
      decrement: (step = 1) => set((current) => current - step),
      reset: () => set(0),
    }),
  });

  const CounterNode = defineNode({
    type: "counter",
    state: {
      count: countState,
    },
  });

  test("counter - types", () => {
    expectTypeOf(countState).toEqualTypeOf<
      StateDefinition<
        number,
        number,
        {
          get: (this: void) => number;
          getPrev: (this: void) => [changed: boolean, value: number];
          increment: (step?: number) => void;
          decrement: (step?: number) => void;
          reset: () => void;
        }
      >
    >();

    expectTypeOf(CounterNode).toEqualTypeOf<
      NodeDefinition<
        "counter",
        {
          count: typeof countState;
        }
      >
    >();

    const doc = new Doc({ extensions: [{ nodes: [CounterNode] }] });
    const node = doc.createNode(CounterNode);

    // Let's test individual methods to see which ones work
    expectTypeOf(node.state.count.get).toEqualTypeOf<(this: void) => number>();

    expectTypeOf(node.state.count).toEqualTypeOf<{
      get: (this: void) => number;
      getPrev: (this: void) => [changed: boolean, value: number];
      increment: (step?: number) => void;
      decrement: (step?: number) => void;
      reset: () => void;
    }>();
  });

  test("counter - runtime", () => {
    const doc = new Doc({ extensions: [{ nodes: [CounterNode] }] });
    checkUndoManager(1, doc, () => {
      const node = doc.createNode(CounterNode);
      doc.root.append(node);
      doc.forceCommit();
      expect(() => node.state.count.getPrev()).toThrowError(getPrevError);
      node.state.count.increment();
      expect(node.state.count.getPrev()).toStrictEqual([true, 0]);
      expect(node.state.count.get()).toBe(1);
      node.state.count.increment(2);
      expect(node.state.count.getPrev()).toStrictEqual([true, 0]);
      expect(node.state.count.get()).toBe(3);
      node.state.count.reset();
      expect(() => node.state.count.getPrev()).toThrowError(getPrevError);
      expect(node.state.count.get()).toBe(0);
    });
  });
});
