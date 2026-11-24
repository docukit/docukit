/* eslint-disable @typescript-eslint/no-empty-function */
import {
  text,
  jsonTree,
  Text,
  assertDoc,
  init,
  assertJson,
  prettifyJson,
  TextExtension,
  TestExtension,
  TestNode,
  checkUndoManager,
  isJsonTree,
} from "./utils.js";
import {
  Doc,
  type DocNode,
  defineNode,
  string,
  defineState,
  defineText,
  type JsonTree,
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
    const X = defineNode({ type: "X", state: { foo: string("default") } });
    const doc = new Doc({ type: "root", extensions: [{ nodes: [X] }] });
    const node1 = doc.createNode(X);
    doc.root.append(node1);
    const json = node1.toJSON();
    expect(prettifyJson(json)).toStrictEqual(["X", {}]);
  });

  test("DocNode.toJSON() - default state should not be included - non primitive value", () => {
    const myObject = v.object({ foo: v.string(), bar: v.string() });

    const X = defineNode({
      type: "X",
      state: {
        myObject: defineState({
          fromJSON: (json) =>
            v.parse(myObject, json ?? { foo: "foo", bar: "bar" }),
        }),
      },
    });
    const doc = new Doc({ type: "root", extensions: [{ nodes: [X] }] });
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
      const doc2 = Doc.fromJSON(
        { id: doc.root.id, type: "root", extensions: [{ nodes: [X] }] },
        json2,
      );
      const node2 = doc2.root.first as DocNode<typeof X>;
      expect(node2.state.myObject.get()).toStrictEqual({
        foo: "foo",
        bar: "bar",
      });
    });
  });

  test("toJSON should throw in normalize or update stage if unsafe is not true", () => {
    const doc = new Doc({
      type: "root",
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
    const doc = Doc.fromJSON({ type: "root", extensions: [TextExtension] }, [
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

  test("extensions can check or convert a stored document as it loads", () => {
    const stored: JsonTree = [
      "01kdjkhm2wkfkcw7xkjdjrd1cc",
      "root",
      {},
      [["1", "old", { value: '"1"' }]],
    ];
    // An older node type becomes a text node, then a second extension checks.
    const doc = Doc.fromJSON(
      {
        type: "root",
        extensions: [
          TextExtension,
          {
            load: (json) =>
              isJsonTree(json)
                ? [json[0], json[1], json[2], [["1", "text", { value: '"1"' }]]]
                : json,
          },
          {
            load: (json) => {
              if (
                isJsonTree(json) &&
                json[3]?.some(([, type]) => type === "old")
              )
                throw new Error("unconverted");
              return json;
            },
          },
        ],
      },
      stored,
    );
    assertDoc(doc, ["1"]);
  });

  test("fromJSON with invalid state should not be imported", () => {
    const doc = Doc.fromJSON({ type: "root", extensions: [TextExtension] }, [
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
    const doc = new Doc({ type: "root", extensions: [TestExtension] });
    const node = doc.createNode(TestNode);
    checkUndoManager(1, doc, () => {
      doc.root.append(node);

      // default value is not exported
      const [_id, ...rest] = node.toJSON();
      expect(rest).toStrictEqual(["test", {}]);
      assertJson(doc, ["root", {}, [["test", {}]]]);
      const doc2 = Doc.fromJSON(
        { id: doc.root.id, type: "root", extensions: [TestExtension] },
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
        { id: doc.root.id, type: "root", extensions: [TestExtension] },
        doc.toJSON({ unsafe: true }),
      );
      const node3 = doc3.root.first as DocNode<typeof TestNode>;
      expect(node3.state.boolean.get()).toStrictEqual(true);
      assertJson(doc3, ["root", {}, [["test", { boolean: "1" }]]]);
    });
  });

  test("fromJSON contains a node that is not registered should throw", () => {
    expect(() =>
      Doc.fromJSON({ type: "root", extensions: [TextExtension] }, [
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
      Doc.fromJSON({ type: "root", extensions: [TextExtension] }, [
        "01kdjkhm2wkfkcw7xkjdjrd1cc",
        "root",
        {},
        [["1", "text", { notRegistered: '"1"' }]],
      ]),
    ).toThrowError(
      "Attempted to create a node of type 'text' with a state that is not registered: notRegistered",
    );
  });

  test.each([
    [
      "a node of the root type below the root",
      [["1", "root", {}]],
      "You cannot insert nodes of type 'root'",
    ],
    [
      "a repeated node id",
      [
        ["1", "text", {}],
        ["2", "text", {}, [["1", "text", {}]]],
      ],
      "Node '1' cannot be inserted because it already exists in the doc.",
    ],
  ] satisfies [string, JsonTree[], string][])(
    "fromJSON with %s should throw",
    (_, children, error) => {
      expect(() =>
        Doc.fromJSON({ type: "root", extensions: [TextExtension] }, [
          "01kdjkhm2wkfkcw7xkjdjrd1cc",
          "root",
          {},
          [children[0]!, ...children.slice(1)],
        ]),
      ).toThrowError(error);
    },
  );

  test("fromJSON with config.id that does not match root node id should throw", () => {
    const jsonWithId = "01kcfhzz66v3393xhggx6aeb6t";
    const configId = "01jjjjjjjjjjjjjjjjjjjjjjjj";

    expect(() =>
      Doc.fromJSON(
        { type: "root", extensions: [TextExtension], id: configId },
        [jsonWithId, "root", {}],
      ),
    ).toThrowError(
      `Attempted to create a document with id '${configId}' that does not match the root node id '${jsonWithId}'.`,
    );
  });

  test("toJSON leaves the id out, and fromJSON takes it from config.id", () => {
    init(({ doc }) => {
      doc.root.first?.next?.append(...text(doc, "2.1", "2.2"));
      const json = doc.toJSON({ unsafe: true });
      expect(JSON.stringify(json)).not.toContain(doc.root.id);
      const config = { type: "root", extensions: [TextExtension] };
      const copy = Doc.fromJSON({ ...config, id: doc.root.id }, json);
      expect(copy.root.id).toBe(doc.root.id);
      expect(copy.toJSON({ unsafe: true })).toStrictEqual(json);
      expect(() => Doc.fromJSON(config, json)).toThrowError(
        "A document stored by `toJSON` does not keep its id: pass it as `config.id`.",
      );
    });
  });

  test("fromJSON with matching config.id and root node id should succeed", () => {
    const id = "01kcfhzz66v3393xhggx6aeb6t";

    const doc = Doc.fromJSON(
      { type: "root", extensions: [TextExtension], id },
      [id, "root", {}],
    );

    expect(doc.root.id).toBe(id);
  });

  test("fromJSON with custom nodeIdGenerator with extractTime validates only root", () => {
    const baseTime = Date.now();
    const doc = Doc.fromJSON(
      {
        type: "root",
        extensions: [TextExtension],
        nodeIdGenerator: {
          generate: () => `ts-${baseTime}`,
          validate: (id) => id.startsWith("ts-"),
          extractTime: (id) => parseInt(id.split("-")[1]!, 10),
        },
      },
      [
        `ts-${baseTime}`,
        "root",
        {},
        [
          ["compact-1", "text", { value: '"1"' }],
          ["compact-2", "text", { value: '"2"' }],
        ],
      ],
    );
    expect(doc.root.id).toBe(`ts-${baseTime}`);
    assertDoc(doc, ["1", "2"]);
  });

  test("fromJSON with custom nodeIdGenerator with extractTime rejects invalid root", () => {
    const baseTime = Date.now();
    expect(() =>
      Doc.fromJSON(
        {
          type: "root",
          extensions: [TextExtension],
          nodeIdGenerator: {
            generate: () => `ts-${baseTime}`,
            validate: (id) => id.startsWith("ts-"),
            extractTime: (id) => parseInt(id.split("-")[1]!, 10),
          },
        },
        ["bad-root", "root", {}],
      ),
    ).toThrowError("Invalid document id: bad-root.");
  });

  test("fromJSON with custom nodeIdGenerator without extractTime validates all nodes", () => {
    const doc = Doc.fromJSON(
      {
        type: "root",
        extensions: [TextExtension],
        nodeIdGenerator: {
          generate: () => `ok-${Date.now()}`,
          validate: (id) => id.startsWith("ok-"),
        },
      },
      [
        "ok-root",
        "root",
        {},
        [
          ["ok-1", "text", { value: '"1"' }],
          ["ok-2", "text", { value: '"2"' }],
        ],
      ],
    );
    expect(doc.root.id).toBe("ok-root");
    assertDoc(doc, ["1", "2"]);
  });

  test("fromJSON with custom nodeIdGenerator without extractTime rejects invalid child", () => {
    expect(() =>
      Doc.fromJSON(
        {
          type: "root",
          extensions: [TextExtension],
          nodeIdGenerator: {
            generate: () => `ok-${Date.now()}`,
            validate: (id) => id.startsWith("ok-"),
          },
        },
        ["ok-root", "root", {}, [["bad-child", "text", { value: '"1"' }]]],
      ),
    ).toThrowError("Invalid node id: bad-child.");
  });
});

describe("stored document", () => {
  /** A document whose nodes get the ids of `ids`, in order. */
  const withIds = (ids: string[]) => {
    const queue = ["01kdjkhm2wkfkcw7xkjdjrd1cc", ...ids];
    const doc = new Doc({
      type: "root",
      extensions: [TextExtension],
      nodeIdGenerator: { generate: () => queue.shift()!, validate: () => true },
    });
    for (const _ of ids) doc.root.append(doc.createNode(Text));
    doc.forceCommit();
    return doc;
  };

  test("nodes of sessions seen before load back with their ids", () => {
    const ids = ["a.0", "b.0", "a.1", "c.0", "b.1"];
    const config = { type: "root", extensions: [TextExtension] };
    const doc = new Doc({
      ...config,
      id: "01kc52hq510g6y44jhq0wqrjb3",
      nodeIdGenerator: {
        generate: () => ids.shift() ?? "z.0",
        validate: () => true,
      },
    });
    doc.root.append(...text(doc, "1", "2", "3", "4", "5"));
    doc.forceCommit();
    const copy = Doc.fromJSON({ ...config, id: doc.root.id }, doc.toJSON());
    expect(jsonTree(copy)).toStrictEqual(jsonTree(doc));
  });

  test("keeps ids of any form as they are", () => {
    // `session.clock` as the default generator writes it, and ids that are
    // not: a clock with a leading zero, characters outside base 64, a clock
    // too long for a column, and no clock at all.
    const ids = ["s.-", "s.0", "s.5", "s.zz", "s.-5", "s.é", "s.x~", "s.abcde"];
    const doc = withIds([...ids, "plain"]);
    const copy = Doc.fromJSON(
      { id: doc.root.id, type: "root", extensions: [TextExtension] },
      doc.toJSON(),
    );
    const loaded: string[] = [];
    copy.root.children().forEach((node) => loaded.push(node.id));
    expect(loaded).toStrictEqual([...ids, "plain"]);
  });

  test("nodes of types in any order keep their types", () => {
    const config = { type: "root", extensions: [TextExtension, TestExtension] };
    const doc = new Doc(config);
    for (const type of [Text, TestNode, Text, TestNode])
      doc.root.append(doc.createNode(type));
    doc.forceCommit();
    const copy = Doc.fromJSON({ ...config, id: doc.root.id }, doc.toJSON());
    const types: string[] = [];
    copy.root.children().forEach((node) => types.push(node.type));
    expect(types).toStrictEqual([
      Text.type,
      TestNode.type,
      Text.type,
      TestNode.type,
    ]);
  });

  test("a root state set back to its default is not stored", () => {
    const Root = defineNode({ type: "root", state: { title: string("") } });
    const doc = new Doc({ type: "root", extensions: [{ nodes: [Root] }] });
    const root = doc.root as DocNode<typeof Root>;
    root.state.title.set("Draft");
    doc.forceCommit();
    expect(doc.toJSON()[2]).toStrictEqual({ title: "Draft" });
    const copy = Doc.fromJSON(
      { type: "root", id: doc.root.id, extensions: [{ nodes: [Root] }] },
      doc.toJSON(),
    );
    const loaded = copy.root;
    expect(loaded.is(Root) ? loaded.state.title.get() : "").toBe("Draft");
    root.state.title.set("");
    doc.forceCommit();
    // An empty state is left out.
    expect(doc.toJSON()).toStrictEqual([[], "root"]);
  });

  test("whole numbers go in a column and load back as they were", () => {
    const Value = defineNode({
      type: "value",
      state: {
        value: defineState({
          fromJSON: (json) =>
            typeof json === "number" || typeof json === "string" ? json : null,
        }),
      },
    });
    const config = { type: "root", extensions: [{ nodes: [Value] }] };
    const doc = new Doc(config);
    const stored = [
      0,
      7,
      7,
      7,
      2 ** 31 + 5,
      Number.MAX_SAFE_INTEGER,
      -3,
      1.5,
      "12",
      2 ** 60,
    ];
    for (const json of stored) {
      const node = doc.createNode(Value);
      node.state.value.set(json);
      doc.root.append(node);
    }
    doc.forceCommit();
    const json = doc.toJSON();
    // Only what is not a whole number of at least 0 stays in `values`.
    expect(json.at(-1)).toStrictEqual([-3, 1.5, "12", 2 ** 60]);
    const loaded: unknown[] = [];
    Doc.fromJSON({ ...config, id: doc.root.id }, json)
      .root.children()
      .forEach((node) => {
        if (node.is(Value)) loaded.push(node.state.value.get());
      });
    expect(loaded).toStrictEqual(stored);
  });

  test("a stored value is what a JSON round trip of it gives", () => {
    const Any = defineNode({
      type: "any",
      state: {
        value: defineState({ fromJSON: (json): unknown => json ?? null }),
      },
    });
    const config = { type: "root", extensions: [{ nodes: [Any] }] };
    const values: unknown[] = [
      new Date(0),
      {
        nan: NaN,
        infinity: -Infinity,
        zero: -0,
        missing: undefined,
        call: () => 1,
        list: [undefined, () => 1, Symbol("s"), 1],
        boxed: [new Number(2), new String("s"), new Boolean(false)],
        own: { toJSON: (key: string) => `key ${key}` },
        proto: JSON.parse('{"__proto__": 1}') as unknown,
      },
    ];
    const doc = new Doc(config);
    for (const value of values) {
      const node = doc.createNode(Any);
      node.state.value.set(value);
      doc.root.append(node);
    }
    doc.forceCommit();
    const roundTrip: unknown = JSON.parse(JSON.stringify(values));
    expect(doc.toJSON().at(-1)).toStrictEqual(roundTrip);
    const loaded: unknown[] = [];
    Doc.fromJSON({ ...config, id: doc.root.id }, doc.toJSON())
      .root.children()
      .forEach((node) => {
        if (node.is(Any)) loaded.push(node.state.value.get());
      });
    expect(loaded).toStrictEqual(roundTrip);
  });

  test("a value is not stored only when JSON writes it as its default", () => {
    const List = defineNode({
      type: "list",
      state: {
        value: defineState({
          fromJSON: (json): unknown => json ?? [1, { a: 1, b: [] }],
        }),
      },
    });
    const config = { type: "root", extensions: [{ nodes: [List] }] };
    const doc = new Doc(config);
    const values = [
      [1, { a: 1, b: [] }],
      [1, { b: [], a: 1 }],
      [1, { a: 1, b: [2] }],
      [1, { a: 1 }],
      [1, { a: 1, c: [] }],
      [1, [1]],
      [1],
      [2, { a: 1, b: [] }],
      { 0: 1, 1: { a: 1, b: [] } },
    ];
    for (const value of values) {
      const node = doc.createNode(List);
      node.state.value.set(value);
      doc.root.append(node);
    }
    doc.forceCommit();
    // The first one is the default; the rest only look like it.
    expect(doc.toJSON().at(-1)).toStrictEqual(values.slice(1));
  });

  test.each([13, 14])(
    "a document an unreleased version stored (format %i) does not load",
    (format) => {
      const config = { type: "root", extensions: [TextExtension] };
      const doc = new Doc(config);
      const stored = doc.toJSON();
      Reflect.set(stored, 0, format);
      // Its sessions are not a list.
      expect(() =>
        Doc.fromJSON({ ...config, id: doc.root.id }, stored),
      ).toThrowError();
    },
  );

  test("a stored document names each type and key once, in one list", () => {
    const config = {
      id: "01kc52hq510g6y44jhq0wqrjb3",
      type: "root",
      extensions: [TextExtension, TestExtension],
    };
    const tree: JsonTree = [
      "01kc52hq510g6y44jhq0wqrjb3",
      "root",
      {},
      [
        ["a.0", "text", { value: '"one"' }],
        [
          "b.0",
          "text",
          { value: '"two"' },
          [
            ["a.1", "test", { string: '"x"', number: "7", boolean: "1" }],
            ["a.2", "test", { number: "-1.5" }],
          ],
        ],
      ],
    ];
    const doc = Doc.fromJSON(config, tree);
    doc.forceCommit();
    const json = doc.toJSON();
    // Sessions, type, no root state (empty), no text, the columns, the names
    // and the values that are not whole numbers.
    expect(json).toHaveLength(6);
    expect(json.slice(0, 3)).toStrictEqual([["a", "b"], "root", 0]);
    expect(json.slice(4)).toStrictEqual([
      ["text", "value", "test", "string", "number", "boolean"],
      ["one", "two", "x", -1.5],
    ]);
    expect(jsonTree(Doc.fromJSON(config, json))).toStrictEqual(tree);
  });

  test("a document with text loads only where a node type defines text", () => {
    const Paragraph = defineNode({ type: "p", state: { t: defineText() } });
    const doc = new Doc({ type: "root", extensions: [{ nodes: [Paragraph] }] });
    const node = doc.createNode(Paragraph);
    doc.root.append(node);
    node.state.t.insert(0, "Hello");
    doc.forceCommit();
    expect(() =>
      Doc.fromJSON(
        {
          id: doc.root.id,
          type: "root",
          extensions: [{ nodes: [Paragraph, Text] }],
        },
        doc.toJSON(),
      ),
    ).not.toThrow();
    expect(() =>
      Doc.fromJSON(
        { id: doc.root.id, type: "root", extensions: [TextExtension] },
        doc.toJSON(),
      ),
    ).toThrowError(
      "The stored document has text, but no node type defines it (see `defineText`).",
    );
  });

  test("a stored value whose JSON is undefined cannot be stored again", () => {
    // It loads as a value with no JSON, which `set` would have refused.
    const Odd = defineNode({
      type: "odd",
      state: {
        value: defineState({
          fromJSON: (json) => (json === "none" ? undefined : String(json)),
        }),
      },
    });
    const doc = Doc.fromJSON({ type: "root", extensions: [{ nodes: [Odd] }] }, [
      "01kdjkhm2wkfkcw7xkjdjrd1cc",
      "root",
      {},
      [["s.0", "odd", { value: '"none"' }]],
    ]);
    expect(() => doc.toJSON({ unsafe: true })).toThrowError(
      "The JSON serialization for state value on a node of type odd is undefined.",
    );
  });
});
