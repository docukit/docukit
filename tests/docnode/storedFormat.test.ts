import {
  Doc,
  defineNode,
  defineState,
  string,
  type ChangeEvent,
  type DocNode,
  type Extension,
  type JsonDoc,
} from "@docukit/docnode";
import { fromLegacyJson } from "@docukit/docnode/compat";
import { describe, expect, test } from "vitest";
import {
  TestExtension,
  TestNode,
  Text,
  checkUndoManager,
  humanReadableOperations,
  idsOf,
  loadAndSave,
  sessionOf,
  text,
  textDoc,
  textDocConfig as config,
  TextExtension,
} from "./utils.js";

const ROOT_ID = "01kc52hq510g6y44jhq0wqrjb3";
type StoredTypes = [name: string, ...keys: string[]][];

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
      [["text", "value"]],
      [0, 0, 0, 0, 0],
      [3, 0, 2, 0, 0, 0],
      [1, 1, 1, 1, 1],
      ["1", "2", "2.1", "2.2", "3"],
      [sessionOf(doc)],
      // clocks 0-1, then 3-4 (1 after the next one, 2), then 2 (3 before 5)
      [0, 0, 2, 0, 1, 2, 0, -3, 1],
    ]);
    expect(loadAndSave(doc)).toStrictEqual(doc.toJSON());
  });

  test("a run of ids can go down, as prepending makes it", () => {
    const doc = textDoc();
    for (const value of ["1", "2", "3"]) doc.root.prepend(...text(doc, value));
    doc.forceCommit();
    expect(idsOf(doc)).toStrictEqual([0, 2, -3]);
    expect(loadAndSave(doc)).toStrictEqual(doc.toJSON());
  });

  test("the ids of nodes of other sessions", () => {
    const a = textDoc();
    const b = Doc.fromJSON(config, a.toJSON());
    b.forceCommit();
    const sent: Parameters<Doc["applyOperations"]>[0][] = [];
    b.onChange(({ operations }) => sent.push(operations));
    b.root.append(...text(b, "b1", "b2"));
    b.forceCommit();
    a.root.append(...text(a, "a1"));
    for (const operations of sent) a.applyOperations(operations);
    a.root.append(...text(a, "a2"));
    a.forceCommit();
    const json = a.toJSON();
    expect(json[8]).toStrictEqual([sessionOf(a), sessionOf(b)]);
    // a1 and a2 are clocks 0 and 1 of the first session, b1 and b2 0 and 1
    // of the second: the session is written minus the previous run's.
    expect(json[9]).toStrictEqual([0, 0, 1, 1, 0, 2, -1, 0, 1]);
    expect(loadAndSave(a)).toStrictEqual(json);
  });

  test("the ids of a custom generator are written as they are", () => {
    let n = 0;
    const custom = {
      ...config,
      nodeIdGenerator: {
        generate: () => `ok-${n++}`,
        validate: (id: string) => id.startsWith("ok-"),
      },
    };
    const doc = new Doc(custom);
    doc.root.append(...text(doc, "1", "2"));
    doc.forceCommit();
    expect(doc.toJSON().slice(8)).toStrictEqual([[], ["ok-1", "ok-2"]]);
    const loaded = Doc.fromJSON(custom, doc.toJSON());
    loaded.forceCommit();
    expect(loaded.toJSON()).toStrictEqual(doc.toJSON());
  });

  test("state values are plain JSON, without the defaults, in the order of the keys", () => {
    const doc = new Doc({ type: "root", extensions: [TestExtension] });
    const node = doc.createNode(TestNode);
    node.state.boolean.set(true);
    node.state.number.set(5);
    node.state.string.set("");
    doc.root.append(node, doc.createNode(TestNode));
    doc.forceCommit();
    const json = doc.toJSON();
    expect(json[3]).toStrictEqual([
      ["test", "string", "number", "boolean", "date"],
    ]);
    expect(json.slice(6, 8)).toStrictEqual([
      [6, 0],
      [5, 1],
    ]);
    expect(loadAndSave(doc)).toStrictEqual(json);
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
      return doc.toJSON()[7];
    };
    expect(stored([1, { a: 2 }])).toStrictEqual([]);
    expect(stored([1, { a: 3 }])).toStrictEqual([[1, { a: 3 }]]);
    expect(stored([1, { b: 2 }])).toStrictEqual([[1, { b: 2 }]]);
    expect(stored([1, { a: 2, b: 3 }])).toStrictEqual([[1, { a: 2, b: 3 }]]);
    expect(stored([1, {}])).toStrictEqual([[1, {}]]);
    expect(stored([1, [2]])).toStrictEqual([[1, [2]]]);
    expect(stored([null])).toStrictEqual([[null]]);
    expect(stored([1])).toStrictEqual([[1]]);
    expect(stored({ 0: 1 })).toStrictEqual([{ 0: 1 }]);
    expect(stored("1")).toStrictEqual(["1"]);
  });

  test("a value that is not plain JSON (a Date) is stored as its JSON", () => {
    const doc = new Doc({ type: "root", extensions: [TestExtension] });
    const node = doc.createNode(TestNode);
    node.state.date.set(new Date(Date.UTC(2026, 10, 25)));
    doc.root.append(node);
    doc.forceCommit();
    expect(doc.toJSON()[7]).toStrictEqual(["2026-11-25T00:00:00.000Z"]);
    expect(loadAndSave(doc)).toStrictEqual(doc.toJSON());
  });

  test("a value whose JSON is undefined throws, also one from operations", () => {
    // `fromJSON` reads "undefined" as `undefined`. Only the sender's
    // definition has a `toJSON` that writes it back.
    const maybe = (toJSON?: (value: unknown) => string) =>
      defineNode({
        type: "maybe",
        state: {
          value: defineState({
            fromJSON: (json) =>
              json === "undefined" ? undefined : (json ?? ""),
            ...(toJSON && { toJSON }),
          }),
        },
      });
    const Sender = maybe((value) => (value === undefined ? "undefined" : ""));
    const sender = new Doc({ type: "root", extensions: [{ nodes: [Sender] }] });
    const receiver = new Doc({
      type: "root",
      id: sender.root.id,
      extensions: [{ nodes: [maybe()] }],
    });
    const events: ChangeEvent[] = [];
    sender.onChange((event) => events.push(event));
    const node = sender.createNode(Sender);
    sender.root.append(node);
    node.state.value.set(undefined);
    sender.forceCommit();
    receiver.applyOperations(events[0]!.operations);
    receiver.forceCommit();
    expect(() => receiver.toJSON()).toThrowError(
      "The JSON serialization for state value on a node of type maybe is undefined.",
    );
  });

  test("a document without other nodes is the root only", () => {
    const doc = textDoc();
    expect(doc.toJSON()).toStrictEqual([doc.root.id, "root", {}]);
    expect(loadAndSave(doc)).toStrictEqual(doc.toJSON());
  });
});

describe("stored format: more shapes", () => {
  test("the root's state is an object of plain JSON", () => {
    const Root = defineNode({
      type: "root",
      state: { a: string(""), b: string("") },
    });
    const doc = new Doc({ type: "root", extensions: [{ nodes: [Root] }] });
    if (!doc.root.is(Root)) throw new Error("The root is of type Root");
    doc.root.state.b.set("x");
    doc.forceCommit();
    expect(doc.toJSON()).toStrictEqual([doc.root.id, "root", { b: "x" }]);
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
      [
        ["text", "value"],
        ["test", "string", "number", "boolean", "date"],
      ],
      [0, 1, 0],
    ]);
    expect(loadAndSave(doc)).toStrictEqual(doc.toJSON());
  });

  test("an object where the default is not one is stored", () => {
    const Any = defineNode({
      type: "any",
      state: {
        value: defineState({ fromJSON: (json): unknown => json ?? "x" }),
      },
    });
    const doc = new Doc({ type: "root", extensions: [{ nodes: [Any] }] });
    const node = doc.createNode(Any);
    node.state.value.set({ a: 1 });
    doc.root.append(node);
    doc.forceCommit();
    expect(doc.toJSON()[7]).toStrictEqual([{ a: 1 }]);
  });

  test("a document with a custom generator loads ids of DocNode's generator", () => {
    const doc = textDoc();
    doc.root.append(...text(doc, "1"));
    doc.forceCommit();
    const custom = {
      ...config,
      nodeIdGenerator: { generate: () => "x", validate: () => true },
    };
    const loaded = Doc.fromJSON(custom, doc.toJSON());
    loaded.forceCommit();
    expect(idsOf(loaded)).toStrictEqual([doc.root.first!.id]);
  });
});

describe("reading a stored document", () => {
  const stored = (types: StoredTypes, states: number[], ids: string[]) =>
    [
      ROOT_ID,
      "root",
      {},
      types,
      ids.map(() => 0),
      [ids.length, ...ids.map(() => 0)],
      states,
      states.filter((state) => state > 0).map(() => "x"),
      [],
      ids,
    ] satisfies JsonDoc;

  test("an id twice throws", () => {
    expect(() =>
      Doc.fromJSON(config, stored([["text", "value"]], [0, 0], ["a.0", "a.0"])),
    ).toThrowError("Node 'a.0' cannot be inserted because it already exists");
  });

  test("a node of the root's type throws", () => {
    expect(() =>
      Doc.fromJSON(config, stored([["root"]], [0], ["a.0"])),
    ).toThrowError("You cannot insert nodes of type 'root'");
  });

  test("a type that is not registered throws", () => {
    expect(() =>
      Doc.fromJSON(config, stored([["other"]], [0], ["a.0"])),
    ).toThrowError(
      "Attempted to create a node of type 'other' that was not registered.",
    );
  });

  test("a state that is not registered throws, unless no node has it", () => {
    const types: StoredTypes = [["text", "gone", "value"]];
    expect(() =>
      Doc.fromJSON(config, stored(types, [1], ["a.0"])),
    ).toThrowError("with a state that is not registered: gone");
    const doc = Doc.fromJSON(config, stored(types, [2], ["a.0"]));
    const node = doc.root.first!;
    if (!node.is(Text)) throw new Error("The node is of type Text");
    expect(node.state.value.get()).toBe("x");
  });

  /** Two text nodes in the root, with the type or children column changed. */
  const twoNodes = (columns: { type?: number[]; children?: number[] }) => {
    const json = stored([["text"]], [0, 0], ["a.0", "a.1"]);
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
    const json = stored([["picky", "value"]], [1, 1], ["a.0", "a.1"]);
    json[7] = ["good", "bad"];
    expect(() =>
      Doc.fromJSON({ type: "root", extensions: [Keep] }, json),
    ).toThrowError("A bad value");
    expect(kept!.root).toBe(rootBefore);
    expect(kept!.toJSON()).toStrictEqual([ROOT_ID, "root", {}]);
    expect(kept!.getNodeById("a.0")).toBeUndefined();
  });

  test("ids of the form session.clock are read as runs, other ids as they are", () => {
    const ids = ["s.-", "s.0", "s.1", "t.0-", "s.-0", "s.é", "s.123456789"];
    const doc = Doc.fromJSON(
      config,
      stored([["text"]], [0, 0, 0, 0, 0, 0, 0], ids),
    );
    doc.forceCommit();
    expect(doc.toJSON().slice(8)).toStrictEqual([
      ["s", "t"],
      [0, 0, 3, 1, 64, 1, "s.-0", "s.é", "s.123456789"],
    ]);
    expect(loadAndSave(doc).slice(8)).toStrictEqual(doc.toJSON().slice(8));
    const noDot = Doc.fromJSON(
      config,
      stored([["text"]], [0, 0], [".0", "x."]),
    );
    noDot.forceCommit();
    expect(idsOf(noDot)).toStrictEqual([".0", "x."]);
  });

  test.each([
    [[2, 0], ["x"], "node 'a.0' has a mask that is not valid."],
    [[-1, 0], ["x"], "node 'a.0' has a mask that is not valid."],
    [[0.5, 0], ["x"], "node 'a.0' has a mask that is not valid."],
    [[1, 1], ["x"], "it has fewer values than its masks say."],
    [[1, 0], ["x", "y"], "it has more values than its masks say."],
    [[0], [], "it has fewer masks than its nodes need."],
    [[0, 0, 0], [], "it has more masks than its nodes need."],
  ])(
    "masks %j with values %j that do not fit throw",
    (masks, values, message) => {
      const json = stored([["text", "value"]], masks, ["a.0", "a.1"]);
      json[7] = values;
      expect(() => Doc.fromJSON(config, json)).toThrowError(
        `Invalid stored document: ${message}`,
      );
    },
  );

  /** The largest clock of an id, `zzzzzzzz`: 8 digits of 64. */
  const MAX_CLOCK = 64 ** 8 - 1;

  /** Two text nodes in the root, with the given sessions and ids columns. */
  const twoNodesWithIds = (
    sessions: string[],
    ids: (string | number)[],
  ): JsonDoc => [
    ROOT_ID,
    "root",
    {},
    [["text"]],
    [0, 0],
    [2, 0, 0],
    [0, 0],
    [],
    sessions,
    ids,
  ];

  test.each([
    [[0, 0, 1], "it has fewer ids than nodes."],
    [[0, 0, 3], "it has more ids than nodes."],
    [[0, 0, 2, "x.0"], "it has more ids than nodes."],
    [[1, 0, 2], "it has an id run that is not valid."],
    [[0, 0, 0], "it has an id run that is not valid."],
    [[0, 0], "it has an id run that is not valid."],
    [[0, 0.5, 2], "it has an id run that is not valid."],
    [[0, -1, 2], "it has an id run that is not valid."],
    [[0, 0, -2], "it has an id run that is not valid."],
    // Clocks have at most 8 digits, as in an id read as text.
    [[0, MAX_CLOCK, 2], "it has an id run that is not valid."],
    [[0, MAX_CLOCK + 1, -2], "it has an id run that is not valid."],
    // The second run would start at an infinite clock.
    [[0, 1e308, 1, 0, 1e308, 1], "it has an id run that is not valid."],
  ])("ids %j that do not fit throw", (ids, message) => {
    expect(() =>
      Doc.fromJSON(config, twoNodesWithIds(["s"], ids)),
    ).toThrowError(`Invalid stored document: ${message}`);
  });

  test("a run can reach the largest clock", () => {
    const doc = Doc.fromJSON(
      config,
      twoNodesWithIds(["s"], [0, MAX_CLOCK - 1, 2]),
    );
    doc.forceCommit();
    expect([doc.root.first!.id, doc.root.last!.id]).toStrictEqual([
      "s.zzzzzzzy",
      "s.zzzzzzzz",
    ]);
  });

  test("an empty session throws", () => {
    expect(() =>
      Doc.fromJSON(config, twoNodesWithIds([""], [0, 0, 2])),
    ).toThrowError(
      "Invalid stored document: it has a session that is not valid.",
    );
  });

  test("a session that is not a string, as parsed JSON could have, throws", () => {
    const sessions = ["s"];
    // Not a string: what `JSON.parse` of a stored document could return.
    Reflect.set(sessions, 0, 5);
    const json = twoNodesWithIds(sessions, [0, 0, 2]);
    expect(() => Doc.fromJSON(config, json)).toThrowError(
      "Invalid stored document: it has a session that is not valid.",
    );
  });

  test("columns without nodes load an empty document", () => {
    const doc = Doc.fromJSON(config, stored([], [], []));
    const events: ChangeEvent[] = [];
    doc.onChange((event) => events.push(event));
    doc.forceCommit();
    expect(events).toStrictEqual([]);
    expect(doc.toJSON()).toStrictEqual([ROOT_ID, "root", {}]);
  });

  /** `count` number states, `s0`, `s1`... */
  const manyStates = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, i) => [
        `s${i}`,
        defineState({ fromJSON: (json) => json ?? 0 }),
      ]),
    );

  test("a node type can have any number of states: one mask per 30 keys", () => {
    const Wide = defineNode({ type: "wide", state: manyStates(120) });
    const wideConfig = { type: "root", extensions: [{ nodes: [Wide] }] };
    const doc = new Doc(wideConfig);
    const node = doc.createNode(Wide);
    doc.root.append(node, doc.createNode(Wide));
    for (const k of [0, 52, 53, 105, 106, 119]) node.state[`s${k}`]!.set(k + 1);
    doc.forceCommit();
    const json = doc.toJSON();
    expect(json.slice(6, 8)).toStrictEqual([
      [1, 2 ** 22 + 2 ** 23, 0, 2 ** 15 + 2 ** 16 + 2 ** 29, 0, 0, 0, 0],
      [1, 53, 54, 106, 107, 120],
    ]);
    const loaded = Doc.fromJSON(wideConfig, json);
    loaded.forceCommit();
    expect(loaded.toJSON()).toStrictEqual(json);
  });

  test("so can the root's type", () => {
    const WideRoot = defineNode({ type: "wideRoot", state: manyStates(40) });
    const wideConfig = {
      type: "wideRoot",
      extensions: [{ nodes: [WideRoot] }],
    };
    const doc = new Doc(wideConfig);
    const root: DocNode = doc.root;
    if (!root.is(WideRoot)) throw new Error("The root is a WideRoot");
    root.state.s35!.set(36);
    doc.forceCommit();
    const json = doc.toJSON();
    expect(json).toStrictEqual([root.id, "wideRoot", { s35: 36 }]);
    const loaded = Doc.fromJSON(wideConfig, json);
    loaded.forceCommit();
    expect(loaded.toJSON()).toStrictEqual(json);
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
    const ids: string[] = [];
    doc.root.descendants().forEach((node) => ids.push(node.id));
    expect(normalized).toStrictEqual([[], ids]);
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
    const legacy = fromLegacyJson([
      ROOT_ID,
      "root",
      { title: '"Doc"' },
      [
        ["a.-", "text", { value: '"1"' }],
        ["a.0", "item", { b: "2", a: '"x"' }, []],
        ["a.1", "item", { a: '"y"' }, [["a.2", "text", {}]]],
      ],
    ]);
    expect(legacy).toStrictEqual([
      ROOT_ID,
      "root",
      { title: "Doc" },
      [
        ["text", "value"],
        ["item", "b", "a"],
      ],
      [0, 1, 1, 0],
      [3, 0, 0, 1, 0],
      [1, 3, 2, 0],
      ["1", 2, "x", "y"],
      [],
      ["a.-", "a.0", "a.1", "a.2"],
    ]);
    expect(fromLegacyJson([ROOT_ID, "root", {}, []])).toStrictEqual([
      ROOT_ID,
      "root",
      {},
    ]);
  });

  test("a type with more than 30 state keys takes one mask per 30 keys", () => {
    const state: Record<string, string> = {};
    for (let k = 0; k < 54; k++) state[`k${k}`] = String(k);
    const [, , , types, , , masks, values] = fromLegacyJson([
      ROOT_ID,
      "root",
      {},
      [
        ["a.0", "wide", { k0: "0" }],
        ["a.1", "wide", state],
      ],
    ]) as Extract<JsonDoc, { length: 10 }>;
    expect(types[0]!.length).toBe(55);
    expect(masks).toStrictEqual([1, 0, 2 ** 30 - 1, 2 ** 24 - 1]);
    expect(values).toStrictEqual([
      0,
      ...Array.from({ length: 54 }, (_, k) => k),
    ]);
  });

  test("a converted document loads, and stores its ids as runs again", () => {
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
  const anyDoc = (value: unknown) => {
    const doc = new Doc(anyConfig);
    const node = doc.createNode(Any);
    node.state.value.set(value);
    doc.root.append(node);
    doc.forceCommit();
    return doc;
  };
  type Value = { a: [number, { b: number }] };
  const valueOf = (doc: Doc) => {
    const node = doc.root.first!;
    if (!node.is(Any)) throw new Error("The first node is of type Any");
    return node.state.value.get() as Value;
  };
  const storedValue = (json: JsonDoc) => json[7]![0] as Value;

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
