import {
  Doc,
  defineNode,
  defineState,
  string,
  type ChangeEvent,
  type DocNode,
  type Extension,
  type Json,
  type JsonDoc,
} from "@docukit/docnode";
import { fromLegacyJson } from "@docukit/docnode/compat";
import { describe, expect, test } from "vitest";
import {
  TestExtension,
  TestNode,
  TextExtension,
  checkUndoManager,
  humanReadableOperations,
  loadAndSave,
  text,
  textDoc,
  textDocConfig as config,
} from "./utils.js";

const ROOT_ID = "01kc52hq510g6y44jhq0wqrjb3";

/** The ids of the nodes of `doc` other than the root, in preorder. */
const idsOf = (doc: Doc) => {
  const ids: string[] = [];
  doc.root.descendants().forEach((node) => ids.push(node.id));
  return ids;
};

/** The stored state of each node of `doc` other than the root. */
const statesOf = (doc: Doc) => doc.toJSON()[6];

describe("stored format", () => {
  test("the root, then the other nodes in preorder as columns", () => {
    const doc = textDoc();
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "1", "2", "3"));
      doc.root.first!.next!.append(...text(doc, "2.1", "2.2"));
    });
    doc.forceCommit();
    expect(doc.toJSON()).toStrictEqual([
      doc.root.id,
      "root",
      {},
      ["text"],
      [0, 0, 0, 0, 0],
      [3, 0, 2, 0, 0, 0],
      ["1", "2", "2.1", "2.2", "3"].map((value) => ({ value })),
      idsOf(doc),
    ]);
    expect(loadAndSave(doc)).toStrictEqual(doc.toJSON());
  });

  test("types alternate", () => {
    const doc = new Doc({
      type: "root",
      extensions: [TextExtension, TestExtension],
    });
    doc.root.append(
      ...text(doc, "1"),
      doc.createNode(TestNode),
      ...text(doc, "2"),
    );
    doc.forceCommit();
    expect(doc.toJSON().slice(3, 5)).toStrictEqual([
      ["text", "test"],
      [0, 1, 0],
    ]);
    expect(loadAndSave(doc)).toStrictEqual(doc.toJSON());
  });

  test("state values are plain JSON, without the defaults", () => {
    const doc = new Doc({ type: "root", extensions: [TestExtension] });
    const node = doc.createNode(TestNode);
    node.state.boolean.set(true);
    node.state.number.set(5);
    node.state.string.set("");
    doc.root.append(node, doc.createNode(TestNode));
    doc.forceCommit();
    expect(statesOf(doc)).toStrictEqual([{ number: 5, boolean: 1 }, {}]);
    expect(loadAndSave(doc)).toStrictEqual(doc.toJSON());
  });

  test("a value equal to its default is not stored, also lists and objects", () => {
    const List = defineNode({
      type: "list",
      state: {
        value: defineState({
          fromJSON: (json): unknown => json ?? [1, { a: 2 }],
        }),
      },
    });
    const doc = new Doc({ type: "root", extensions: [{ nodes: [List] }] });
    const stored = (value: unknown) => {
      const node = doc.createNode(List);
      node.state.value.set(value);
      doc.root.replaceChildren(node);
      doc.forceCommit();
      return statesOf(doc)![0];
    };
    expect(stored([1, { a: 2 }])).toStrictEqual({});
    expect(stored([1, { a: 3 }])).toStrictEqual({ value: [1, { a: 3 }] });
    expect(stored([1, { b: 2 }])).toStrictEqual({ value: [1, { b: 2 }] });
    expect(stored([1, { a: 2, b: 3 }])).toStrictEqual({
      value: [1, { a: 2, b: 3 }],
    });
    expect(stored([1, {}])).toStrictEqual({ value: [1, {}] });
    expect(stored([1, [2]])).toStrictEqual({ value: [1, [2]] });
    expect(stored([null])).toStrictEqual({ value: [null] });
    expect(stored([1])).toStrictEqual({ value: [1] });
    expect(stored({ 0: 1 })).toStrictEqual({ value: { 0: 1 } });
    expect(stored("1")).toStrictEqual({ value: "1" });
  });

  test("a value that is not plain JSON (a Date) is stored as its JSON", () => {
    const doc = new Doc({ type: "root", extensions: [TestExtension] });
    const node = doc.createNode(TestNode);
    node.state.date.set(new Date(Date.UTC(2026, 10, 25)));
    doc.root.append(node);
    doc.forceCommit();
    expect(statesOf(doc)).toStrictEqual([{ date: "2026-11-25T00:00:00.000Z" }]);
  });

  test("a document without other nodes is the root only", () => {
    const Root = defineNode({
      type: "root",
      state: { a: string(""), b: string("") },
    });
    const doc = new Doc({ type: "root", extensions: [{ nodes: [Root] }] });
    expect(doc.toJSON()).toStrictEqual([doc.root.id, "root", {}]);
    if (!doc.root.is(Root)) throw new Error("The root is of type Root");
    doc.root.state.b.set("x");
    doc.forceCommit();
    expect(doc.toJSON()).toStrictEqual([doc.root.id, "root", { b: "x" }]);
    expect(loadAndSave(doc)).toStrictEqual(doc.toJSON());
  });
});

describe("reading a stored document", () => {
  const stored = (
    types: string[],
    ids: string[],
    states: Record<string, Json>[] = ids.map(() => ({ value: "x" })),
  ) =>
    [
      ROOT_ID,
      "root",
      {},
      types,
      ids.map(() => 0),
      [ids.length, ...ids.map(() => 0)],
      states,
      ids,
    ] satisfies JsonDoc;

  test("an id twice throws", () => {
    expect(() =>
      Doc.fromJSON(config, stored(["text"], ["a.0", "a.0"])),
    ).toThrowError("Node 'a.0' cannot be inserted because it already exists");
  });

  test("a node of the root's type throws", () => {
    expect(() => Doc.fromJSON(config, stored(["root"], ["a.0"]))).toThrowError(
      "You cannot insert nodes of type 'root'",
    );
  });

  test("a type that is not registered throws", () => {
    expect(() => Doc.fromJSON(config, stored(["other"], ["a.0"]))).toThrowError(
      "Attempted to create a node of type 'other' that was not registered.",
    );
  });

  test("a state that is not registered throws", () => {
    const json = stored(["text"], ["a.0"], [{ gone: "x" }]);
    expect(() => Doc.fromJSON(config, json)).toThrowError(
      "with a state that is not registered: gone",
    );
  });

  /** Two text nodes in the root, with the type or children column changed. */
  const twoNodes = (columns: { type?: number[]; children?: number[] }) => {
    const json = stored(["text"], ["a.0", "a.1"]);
    if (columns.type) json[4] = columns.type;
    if (columns.children) json[5] = columns.children;
    return json;
  };

  test.each([
    [{ type: [0] }, "its columns do not have matching lengths."],
    [{ children: [2, 0] }, "its columns do not have matching lengths."],
    [{ children: [3, 0, 0] }, "it counts more children than it has nodes."],
    [{ children: [1, 0, 0] }, "it has nodes that no parent counts."],
    [{ type: [0, 1] }, "node 'a.1' has type 1, which is not in its types."],
    [{ children: [1, -1, 0] }, "-1 is not a number of children."],
    [{ children: [2, 0.5, 0] }, "0.5 is not a number of children."],
  ])("columns %j that do not fit throw", (columns, message) => {
    expect(() => Doc.fromJSON(config, twoNodes(columns))).toThrowError(
      `Invalid stored document: ${message}`,
    );
  });

  test("a load that throws halfway leaves the document as it was", () => {
    const Picky = defineNode({
      type: "picky",
      state: {
        value: defineState({
          fromJSON: (json) => {
            if (json === "bad") throw new Error("A bad value");
            return json ?? "";
          },
        }),
      },
    });
    let kept: Doc | undefined;
    let rootBefore: DocNode | undefined;
    const Keep: Extension = {
      nodes: [Picky],
      register: (doc) => {
        kept = doc;
        rootBefore = doc.root;
      },
    };
    const json = stored(
      ["picky"],
      ["a.0", "a.1"],
      [{ value: "good" }, { value: "bad" }],
    );
    expect(() =>
      Doc.fromJSON({ type: "root", extensions: [Keep] }, json),
    ).toThrowError("A bad value");
    expect(kept!.root).toBe(rootBefore);
    expect(kept!.toJSON()).toStrictEqual([ROOT_ID, "root", {}]);
    expect(kept!.getNodeById("a.0")).toBeUndefined();
  });

  test("columns without nodes load an empty document", () => {
    const doc = Doc.fromJSON(config, stored([], []));
    const events: ChangeEvent[] = [];
    doc.onChange((event) => events.push(event));
    doc.forceCommit();
    expect(events).toStrictEqual([]);
    expect(doc.toJSON()).toStrictEqual([ROOT_ID, "root", {}]);
  });
});

describe("loading a stored document is a transaction that inserts it", () => {
  /** "1" with "1.1" and "1.2" in it, an empty "2", and "3", stored. */
  const storedTree = () => {
    const doc = textDoc();
    doc.root.append(...text(doc, "1", "", "3"));
    doc.root.first!.append(...text(doc, "1.1", "1.2"));
    doc.forceCommit();
    return doc.toJSON();
  };

  test("normalize and change see the loaded nodes on the first commit", () => {
    const normalized: string[][] = [];
    const Normalize: Extension = {
      register: (doc) =>
        doc.onNormalize(({ diff }) => normalized.push([...diff.inserted])),
    };
    const doc = Doc.fromJSON(
      { ...config, strictMode: false, extensions: [TextExtension, Normalize] },
      storedTree(),
    );
    // The document's creation, before the load.
    expect(normalized).toStrictEqual([[]]);
    const events: ChangeEvent[] = [];
    doc.onChange((event) => events.push(event));
    doc.forceCommit();
    expect(normalized).toStrictEqual([[], idsOf(doc)]);
    expect(events).toHaveLength(1);
    expect(humanReadableOperations(doc, events[0]!)).toStrictEqual({
      operations: [
        "INSERT: undefined --> 1 -  - 3 <-- undefined | PARENT: ROOT",
        "INSERT: undefined --> 1.1 - 1.2 <-- undefined | PARENT: 1",
        'UPDATE: {"1":{"value":"1"},"3":{"value":"3"},"1.1":{"value":"1.1"},"1.2":{"value":"1.2"}}',
      ],
      inverseOperations: ["DELETE: from 1 to 3"],
      diff: {
        deleted: {},
        inserted: new Set(["1", "1.1", "1.2", "", "3"]),
        moved: new Set(),
        updated: new Set(),
      },
    });
  });

  test("its operations build the same document from an empty one", () => {
    const json = storedTree();
    const doc = Doc.fromJSON(config, json);
    const events: ChangeEvent[] = [];
    doc.onChange((event) => events.push(event));
    doc.forceCommit();
    const replica = new Doc({ ...config, id: json[0] });
    replica.applyOperations(events[0]!.operations);
    replica.forceCommit();
    expect(replica.toJSON()).toStrictEqual(json);
  });
});

describe("fromLegacyJson", () => {
  test("converts a document of the previous format", () => {
    expect(
      fromLegacyJson([
        ROOT_ID,
        "root",
        { title: '"Doc"' },
        [
          ["a.-", "text", { value: '"1"' }],
          ["a.0", "item", { b: "2", a: '"x"' }, []],
          ["a.1", "item", { a: "[1,{}]" }, [["a.2", "text", {}]]],
        ],
      ]),
    ).toStrictEqual([
      ROOT_ID,
      "root",
      { title: "Doc" },
      ["text", "item"],
      [0, 1, 1, 0],
      [3, 0, 0, 1, 0],
      [{ value: "1" }, { b: 2, a: "x" }, { a: [1, {}] }, {}],
      ["a.-", "a.0", "a.1", "a.2"],
    ]);
    expect(fromLegacyJson([ROOT_ID, "root", {}, []])).toStrictEqual([
      ROOT_ID,
      "root",
      {},
    ]);
  });

  test("a converted document loads as it was stored", () => {
    const doc = textDoc();
    doc.root.append(...text(doc, "1", "2"));
    doc.forceCommit();
    const [first, second] = [doc.root.first!, doc.root.last!];
    const loaded = Doc.fromJSON(
      config,
      fromLegacyJson([
        doc.root.id,
        "root",
        {},
        [
          [first.id, "text", { value: '"1"' }],
          [second.id, "text", { value: '"2"' }],
        ],
      ]),
    );
    loaded.forceCommit();
    expect(loaded.toJSON()).toStrictEqual(doc.toJSON());
  });
});

describe("state values are frozen in development and tests", () => {
  const Any = defineNode({
    type: "any",
    state: {
      value: defineState({ fromJSON: (json): unknown => json ?? null }),
    },
  });
  const anyConfig = { type: "root", extensions: [{ nodes: [Any] }] };
  type Value = { a: [number, { b: number }] };
  const anyDoc = (value: unknown) => {
    const doc = new Doc(anyConfig);
    const node = doc.createNode(Any);
    node.state.value.set(value);
    doc.root.append(node);
    doc.forceCommit();
    return doc;
  };
  const valueOf = (doc: Doc) => {
    const node: DocNode = doc.root.first!;
    if (!node.is(Any)) throw new Error("The first node is of type Any");
    return node.state.value.get() as Value;
  };
  const storedValue = (json: JsonDoc) => json[6]![0]!.value as Value;

  test("a value set cannot be changed in place", () => {
    const value = { a: [1, { b: 2 }] };
    anyDoc(value);
    expect(() => (value.a[1] = 3)).toThrow(TypeError);
    expect(Object.isFrozen(value.a[1])).toBe(true);
  });

  test("toJSON does not copy values: it returns the frozen state", () => {
    const doc = anyDoc({ a: [1, { b: 2 }] });
    const stored = storedValue(doc.toJSON());
    expect(stored).toBe(valueOf(doc));
    expect(() => (stored.a[1].b = 3)).toThrow(TypeError);
    expect(valueOf(doc)).toStrictEqual({ a: [1, { b: 2 }] });
  });

  test("fromJSON does not copy values: it keeps them, frozen", () => {
    const json = anyDoc({ a: [1, { b: 2 }] }).toJSON();
    const loaded = Doc.fromJSON(anyConfig, json);
    expect(valueOf(loaded)).toBe(storedValue(json));
    expect(() => (valueOf(loaded).a[1].b = 3)).toThrow(TypeError);
  });

  test("a value applied from operations is frozen", () => {
    const source = anyDoc(null);
    const replica = Doc.fromJSON(anyConfig, source.toJSON());
    replica.forceCommit();
    source.onChange(({ operations }) => replica.applyOperations(operations));
    const node = source.root.first!;
    if (node.is(Any)) node.state.value.set({ a: [3, { b: 4 }] });
    source.forceCommit();
    expect(valueOf(replica)).toStrictEqual({ a: [3, { b: 4 }] });
    expect(() => (valueOf(replica).a[1].b = 5)).toThrow(TypeError);
  });

  test("only plain objects and lists are frozen", () => {
    const date = new Date(Date.UTC(2026, 10, 25));
    const value = { at: date };
    anyDoc(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(date)).toBe(false);
  });
});
