import { Doc, defineNode, defineState, string } from "@docukit/docnode";
import { fromLegacyJson } from "@docukit/docnode/compat";
import { describe, expect, test } from "vitest";
import {
  TestExtension,
  TestNode,
  checkUndoManager,
  loadAndSave,
  text,
  textDoc,
  textDocConfig as config,
} from "./utils.js";

const ROOT_ID = "01kc52hq510g6y44jhq0wqrjb3";

describe("stored format", () => {
  test("state values are plain JSON, without the defaults", () => {
    const doc = new Doc({ type: "root", extensions: [TestExtension] });
    checkUndoManager(1, doc, () => {
      const node = doc.createNode(TestNode);
      node.state.boolean.set(true);
      node.state.number.set(5);
      node.state.string.set("");
      doc.root.append(node, doc.createNode(TestNode));
    });
    doc.forceCommit();
    const [first, second] = [doc.root.first!.id, doc.root.last!.id];
    expect(doc.toJSON()).toStrictEqual([
      doc.root.id,
      "root",
      {},
      [
        [first, "test", { number: 5, boolean: 1 }],
        [second, "test", {}],
      ],
    ]);
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
      return doc.toJSON()[3]![0][2];
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
    expect(doc.toJSON()[3]![0][2]).toStrictEqual({
      date: "2026-11-25T00:00:00.000Z",
    });
  });

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
});

describe("fromLegacyJson", () => {
  test("parses each state value of the previous format", () => {
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
      [
        ["a.-", "text", { value: "1" }],
        ["a.0", "item", { b: 2, a: "x" }],
        ["a.1", "item", { a: [1, {}] }, [["a.2", "text", {}]]],
      ],
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
  const anyDoc = (value: unknown) => {
    const doc = new Doc(anyConfig);
    const node = doc.createNode(Any);
    node.state.value.set(value);
    doc.root.append(node);
    doc.forceCommit();
    return doc;
  };
  const valueOf = (doc: Doc) => {
    const node = doc.root.first!;
    if (!node.is(Any)) throw new Error("The first node is of type Any");
    return node.state.value.get() as { a: [number, { b: number }] };
  };
  const storedValue = (doc: Doc) =>
    doc.toJSON()[3]![0][2].value as { a: [number, { b: number }] };

  test("a value set cannot be changed in place", () => {
    const value = { a: [1, { b: 2 }] };
    anyDoc(value);
    expect(() => (value.a[1] = 3)).toThrow(TypeError);
    expect(Object.isFrozen(value.a[1])).toBe(true);
  });

  test("toJSON does not copy values: it returns the frozen state", () => {
    const doc = anyDoc({ a: [1, { b: 2 }] });
    const stored = storedValue(doc);
    expect(stored).toBe(valueOf(doc));
    expect(() => (stored.a[1].b = 3)).toThrow(TypeError);
    expect(valueOf(doc)).toStrictEqual({ a: [1, { b: 2 }] });
  });

  test("fromJSON does not copy values: it keeps them, frozen", () => {
    const json = anyDoc({ a: [1, { b: 2 }] }).toJSON();
    const loaded = Doc.fromJSON(anyConfig, json);
    expect(valueOf(loaded)).toBe(json[3]![0][2].value);
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
