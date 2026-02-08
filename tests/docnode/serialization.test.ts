/* eslint-disable @typescript-eslint/no-empty-function */
import {
  text,
  Text,
  assertDoc,
  init,
  assertJson,
  prettifyJson,
  TextExtension,
  TestExtension,
  TestNode,
  checkUndoManager,
} from "./utils.js";
import {
  Doc,
  type DocNode,
  defineNode,
  string,
  defineState,
} from "@docukit/docnode";
import { test, expect, describe } from "vitest";
import * as v from "valibot";

describe.todo("toJSON", () => {});
describe.todo("fromJSON", () => {});

describe("json serialization", () => {
  test("toJSON", () => {
    init(({ doc }) => {
      const state1 = ["1", "2", "__2.1", "__2.2", "3", "4"];
      doc.root.first?.next?.append(...text(doc, "2.1", "2.2"));
      assertDoc(doc, state1);
      // IMPORTANT: Make sure c is always the last property of each node.
      // It makes the JSON more readable/understandable.
      assertJson(doc, [
        "root",
        {},
        [
          ["text", { value: '"1"' }],
          [
            "text",
            { value: '"2"' },
            [
              ["text", { value: '"2.1"' }],
              ["text", { value: '"2.2"' }],
            ],
          ],
          ["text", { value: '"3"' }],
          ["text", { value: '"4"' }],
        ],
      ]);
    });
  });

  test("DocNode.toJSON() - default state should not be included", () => {
    const X = defineNode({
      type: "X",
      state: {
        foo: string("default"),
      },
    });
    const doc = new Doc({ extensions: [{ nodes: [X] }] });
    const node1 = doc.createNode(X);
    doc.root.append(node1);
    const json = node1.toJSON();
    expect(prettifyJson(json)).toStrictEqual(["X", {}]);
  });

  test("DocNode.toJSON() - default state should not be included - non primitive value", () => {
    const myObject = v.object({
      foo: v.string(),
      bar: v.string(),
    });

    const X = defineNode({
      type: "X",
      state: {
        myObject: defineState({
          fromJSON: (json) =>
            v.parse(myObject, json ?? { foo: "foo", bar: "bar" }),
        }),
      },
    });
    const doc = new Doc({ extensions: [{ nodes: [X] }] });
    checkUndoManager(1, doc, () => {
      const node1 = doc.createNode(X);
      doc.root.append(node1);
      assertJson(doc, ["root", {}, [["X", {}]]]);
      node1.state.myObject.set({ foo: "foo2", bar: "bar2" });
      assertJson(doc, [
        "root",
        {},
        [["X", { myObject: '{"foo":"foo2","bar":"bar2"}' }]],
      ]);
      // setting state to default value
      node1.state.myObject.set({ foo: "foo", bar: "bar" });
      assertJson(doc, ["root", {}, [["X", {}]]]);
      const json2 = doc.toJSON({ unsafe: true });
      const doc2 = Doc.fromJSON({ extensions: [{ nodes: [X] }] }, json2);
      const node2 = doc2.root.first as DocNode<typeof X>;
      expect(node2.state.myObject.get()).toStrictEqual({
        foo: "foo",
        bar: "bar",
      });
    });
  });

  test("toJSON should throw in normalize or update stage if unsafe is not true", () => {
    const doc = new Doc({
      extensions: [
        {
          nodes: [Text],
          register: (doc) => {
            doc.onNormalize(() => {
              expect(() => doc.toJSON()).toThrowError(
                "Cannot serialize a document during an active transaction.",
              );
            });
          },
        },
      ],
    });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "1"));
      expect(() => doc.toJSON()).toThrowError(
        "Cannot serialize a document during an active transaction.",
      );
    });
  });

  test("fromJSON", () => {
    const doc = Doc.fromJSON({ extensions: [TextExtension] }, [
      "01kdjkhm2wkfkcw7xkjdjrd1cc",
      "root",
      {},
      [
        ["1", "text", { value: '"1"' }],
        [
          "2",
          "text",
          { value: '"2"' },
          [
            ["2.1", "text", { value: '"2.1"' }],
            ["2.2", "text", { value: '"2.2"' }],
          ],
        ],
        ["3", "text", { value: '"3"' }],
        ["4", "text", { value: '"4"' }],
      ],
    ]);
    assertDoc(doc, ["1", "2", "__2.1", "__2.2", "3", "4"]);
  });

  test("fromJSON with invalid state should not be imported", () => {
    const doc = Doc.fromJSON({ extensions: [TextExtension] }, [
      "01kdjkhm2wkfkcw7xkjdjrd1cc",
      "root",
      {},
      [
        // value is a number here, but it should be a string
        ["1", "text", { value: "1" }],
      ],
    ]);
    const node = doc.root.first as DocNode<typeof Text>;
    expect(node.state.value.get()).toStrictEqual("");
    assertJson(doc, ["root", {}, [["text", {}]]]);
  });

  test("Boolean state should be serialized as a number", () => {
    const doc = new Doc({ extensions: [TestExtension] });
    const node = doc.createNode(TestNode);
    checkUndoManager(1, doc, () => {
      doc.root.append(node);

      // default value is not exported
      const [_id, ...rest] = node.toJSON();
      expect(rest).toStrictEqual(["test", {}]);
      assertJson(doc, ["root", {}, [["test", {}]]]);
      const doc2 = Doc.fromJSON(
        { extensions: [TestExtension] },
        doc.toJSON({ unsafe: true }),
      );
      const node2 = doc2.root.first as DocNode<typeof TestNode>;
      expect(node2.state.boolean.get()).toStrictEqual(false);
      assertJson(doc2, ["root", {}, [["test", {}]]]);

      // setting value to true
      node.state.boolean.set(true);
      const [_id2, ...rest2] = node.toJSON();
      expect(rest2).toStrictEqual(["test", { boolean: "1" }]);
      assertJson(doc, ["root", {}, [["test", { boolean: "1" }]]]);
      const doc3 = Doc.fromJSON(
        { extensions: [TestExtension] },
        doc.toJSON({ unsafe: true }),
      );
      const node3 = doc3.root.first as DocNode<typeof TestNode>;
      expect(node3.state.boolean.get()).toStrictEqual(true);
      assertJson(doc3, ["root", {}, [["test", { boolean: "1" }]]]);
    });
  });

  test("fromJSON contains a node that is not registered should throw", () => {
    expect(() =>
      Doc.fromJSON({ extensions: [TextExtension] }, [
        "01kdjkhm2wkfkcw7xkjdjrd1cc",
        "root",
        {},
        [["1", "node-not-registered", { value: '"1"' }]],
      ]),
    ).toThrowError(
      "Attempted to create a node of type 'node-not-registered' that was not registered.",
    );
  });

  test("fromJSON contains a state that is not registered should throw", () => {
    expect(() =>
      Doc.fromJSON({ extensions: [TextExtension] }, [
        "01kdjkhm2wkfkcw7xkjdjrd1cc",
        "root",
        {},
        [["1", "text", { notRegistered: '"1"' }]],
      ]),
    ).toThrowError(
      "Attempted to create a node of type 'text' with a state that is not registered: notRegistered",
    );
  });

  test("fromJSON with config.id that does not match root node id should throw", () => {
    const jsonWithId = "01kcfhzz66v3393xhggx6aeb6t";
    const configId = "01jjjjjjjjjjjjjjjjjjjjjjjj";

    expect(() =>
      Doc.fromJSON({ extensions: [TextExtension], id: configId }, [
        jsonWithId,
        "root",
        {},
      ]),
    ).toThrowError(
      `Attempted to create a document with id '${configId}' that does not match the root node id '${jsonWithId}'.`,
    );
  });

  test("fromJSON with matching config.id and root node id should succeed", () => {
    const id = "01kcfhzz66v3393xhggx6aeb6t";

    const doc = Doc.fromJSON({ extensions: [TextExtension], id }, [
      id,
      "root",
      {},
    ]);

    expect(doc.root.id).toBe(id);
  });
});
