import { describe, expect, expectTypeOf, test, vi } from "vitest";
import {
  Doc,
  type DocNode,
  type DeepImmutable,
  defineNode,
  string,
} from "@docukit/docnode";
import {
  TestNode,
  Text,
  assertDoc,
  init,
  text,
  assertError,
  TextExtension,
  DOCNODE_ID,
  checkUndoManager,
} from "./utils.js";
import { ULID_REGEX } from "valibot";

describe("accessors & getters", () => {
  init(({ doc, root, node1, node2, node4 }) => {
    test("id", () => {
      expect(node1.id.length).toBe(6); // can be greater than 6 in other conditions
      expect(node1.id).toMatch(DOCNODE_ID("[-0123456789]", "-"));
      const ULID = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;
      expect(root.id).toMatch(ULID);
      // @ts-expect-error - id is read-only. Should I make it non-writable?
      const _fn = () => (node1.id = node1.id);
    });

    test("id generator", () => {
      const msBase = Date.now();

      const assertTimeId = (ms: number, value: string) => {
        const spy = vi
          .spyOn(Date, "now")
          .mockImplementationOnce(() => msBase) // ulid() in Doc constructor
          .mockImplementationOnce(() => msBase + ms);
        const doc = new Doc({ type: "root", extensions: [{ nodes: [Text] }] });
        spy.mockRestore();
        let id!: string;
        for (let i = 0; i <= ms; i++) {
          id = doc["_nodeIdGenerator"](doc);
          if (i === 0) expect(id).toMatch(DOCNODE_ID(value, "-"));
        }
        expect(id).toMatch(DOCNODE_ID(value, value));
      };

      assertTimeId(0, "-");
      assertTimeId(1, "0");
      assertTimeId(10, "9");
      assertTimeId(37, "_");
      assertTimeId(64, "0-");
      assertTimeId(64 ** 3 - 1, "zzz");
      assertTimeId(64 ** 3, "0---");
    });

    test("id generator with nodeIdGenerator: 'ulid' generates lowercase ULIDs for all nodes", () => {
      const doc = new Doc({
        type: "test",
        extensions: [TextExtension],
        nodeIdGenerator: "ulid",
      });
      expect(doc.root.id).toMatch(ULID_REGEX);
      const node = doc.createNode(Text);
      expect(node.id).toMatch(ULID_REGEX);
    });

    test("type", () => {
      expect(node1.type).toBe("text");
      expect(root.type).toBe("root");
      // @ts-expect-error - type is read-only. Should I make it non-writable?
      const _fn = () => (node1.type = node1.type);
    });

    test("parent", () => {
      expectTypeOf(node1.parent).toEqualTypeOf<DocNode | undefined>();
      expect(node1.parent).toBe(root);
      expect(root.parent).toBeUndefined();
      // @ts-expect-error - setter is private
      const _fn = () => (root.parent = root.prev);
    });

    test("prev", () => {
      expectTypeOf(node1.prev).toEqualTypeOf<DocNode | undefined>();
      expect(node1.prev).toBeUndefined();
      expect(node2.prev).toBe(node1);
      expect(root.prev).toBeUndefined();
      // @ts-expect-error - setter is private
      const _fn = () => (root.prev = root.next);
    });

    test("next", () => {
      expectTypeOf(node1.next).toEqualTypeOf<DocNode | undefined>();
      expect(node1.next).toBe(node2);
      expect(node4.next).toBeUndefined();
      expect(root.next).toBeUndefined();
      // @ts-expect-error - setter is private
      const _fn = () => (root.next = root.prev);
    });

    test("first", () => {
      expectTypeOf(node1.first).toEqualTypeOf<DocNode | undefined>();
      expect(root.first).toBe(node1);
      expect(node1.first).toBe(undefined);
      // @ts-expect-error - setter is private
      const _fn = () => (root.first = root.prev);
    });

    test("last", () => {
      expectTypeOf(node1.last).toEqualTypeOf<DocNode | undefined>();
      expect(root.last).toBe(node4);
      expect(node1.last).toBeUndefined();
      // @ts-expect-error - setter is private
      const _fn = () => (root.last = root.prev);
    });

    test("root", () => {
      expect(doc.root).toBe(root);
      expectTypeOf(doc.root).toEqualTypeOf<DocNode>();
    });

    test("getNodeById", () => {
      expect(doc.getNodeById(node1.id)).toBe(node1);
      expect(doc.getNodeById("asd")).toBeUndefined();
    });
  });
});

describe("is", () => {
  const TestNode2 = defineNode({ type: "test", state: { foo: string("") } });
  const TestNode3 = defineNode({ type: "test", state: { bar: string("") } });
  const X = defineNode({ type: "X", state: { bar: string("") } });
  const doc = new Doc({
    type: "root",
    extensions: [{ nodes: [TestNode, TestNode2, TestNode3, X] }],
  });
  const node = doc.createNode(TestNode);
  const unknownNode = doc.root as unknown as DocNode;

  test("same type returns true (even with different nodeDefinitions)", () => {
    expect(node.is(TestNode)).toBe(true);
    expect(node.is(TestNode2)).toBe(true);
  });

  test("different type returns false", () => {
    expect(node.is(X)).toBe(false);
  });

  // TODO (maybe): at least 1 nodeDef is not registered. What should I do? throw error? return false?
  // currently I don't check this so if it has the same type it will return true

  test("inferred type is given by the nodeDefinition", () => {
    if (unknownNode.is(TestNode)) {
      expectTypeOf(unknownNode).toEqualTypeOf<DocNode<typeof TestNode>>();
    }
  });

  // typeScript-only test. We don't verify this in runtime.
  test("does not accept parameters of different types", () => {
    // @ts-expect-error - parameters need to have the same type
    unknownNode.is(TestNode, X);
  });

  test("accepts multiple parameters of the same type", () => {
    expect(node.is(TestNode, TestNode2, TestNode3)).toBe(true);
    if (unknownNode.is(TestNode, TestNode2, TestNode3)) {
      expectTypeOf(unknownNode).toEqualTypeOf<
        DocNode<typeof TestNode & typeof TestNode2 & typeof TestNode3>
      >();
      expectTypeOf<keyof typeof unknownNode.state>().toEqualTypeOf<
        "string" | "number" | "boolean" | "date" | "foo" | "bar"
      >();
      expectTypeOf(unknownNode.state.string.get()).toEqualTypeOf<string>();
      expectTypeOf(unknownNode.state.number.get()).toEqualTypeOf<number>();
      expectTypeOf(unknownNode.state.boolean.get()).toEqualTypeOf<boolean>();
      expectTypeOf(unknownNode.state.date.get()).toEqualTypeOf<
        DeepImmutable<Date>
      >();
      expectTypeOf(unknownNode.state.foo.get()).toEqualTypeOf<string>();
      expectTypeOf(unknownNode.state.bar.get()).toEqualTypeOf<string>();

      type Intersection = DocNode<typeof TestNode> &
        DocNode<typeof TestNode2> &
        DocNode<typeof TestNode3>;
      // Note the "not." I could make them equal if methods like getState
      // and setState were functions instead of methods. But it's not worth it, imo.
      expectTypeOf(unknownNode).not.toEqualTypeOf<Intersection>();
    }
    // For documentation purposes, this would result in an intersection type
    if (
      unknownNode.is(TestNode) &&
      unknownNode.is(TestNode2) &&
      unknownNode.is(TestNode3)
    ) {
      expectTypeOf(unknownNode).toEqualTypeOf<
        DocNode<typeof TestNode> &
          DocNode<typeof TestNode2> &
          DocNode<typeof TestNode3>
      >();
      expectTypeOf<keyof typeof unknownNode.state>().toEqualTypeOf<
        "string" | "number" | "boolean" | "date" | "foo" | "bar"
      >();
      expectTypeOf(unknownNode.state.string.get()).toEqualTypeOf<string>();
      expectTypeOf(unknownNode.state.number.get()).toEqualTypeOf<number>();
      expectTypeOf(unknownNode.state.boolean.get()).toEqualTypeOf<boolean>();
      expectTypeOf(unknownNode.state.date.get()).toEqualTypeOf<
        DeepImmutable<Date>
      >();
      expectTypeOf(unknownNode.state.foo.get()).toEqualTypeOf<string>();
      expectTypeOf(unknownNode.state.bar.get()).toEqualTypeOf<string>();
    }
  });
});

describe("descendants", () => {
  test("works outside of doc.update", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    doc.root.descendants().forEach((node) => nodes.push(node));
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1", "2", "3", "4"]);
    const node2 = doc.root
      .descendants()
      .find(
        (node): node is DocNode<typeof Text> =>
          node.is(Text) && node.state.value.get() === "2",
      );
    expect(node2).toBeDefined();
    expect(node2?.state.value.get()).toBe("2");
  });
  test("forEach excludes self", () => {
    let doc!: Doc;
    init(({ doc: doc2, node1, node3 }) => {
      doc = doc2;
      node1.append(...text(doc, "1.1", "1.2", "1.3"));
      node3.append(...text(doc, "3.1", "3.2", "3.3"));
    });
    assertDoc(doc, [
      "1",
      "__1.1",
      "__1.2",
      "__1.3",
      "2",
      "3",
      "__3.1",
      "__3.2",
      "__3.3",
      "4",
    ]);
    const nodes: DocNode[] = [];
    const deepLevels: number[] = [];
    doc.root.descendants().forEach((node, deepLevel) => {
      nodes.push(node);
      deepLevels.push(deepLevel);
      // shouldn't change in the next iterations
      if (deepLevel === 1) deepLevel = 4;
    });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual([
      "1",
      "1.1",
      "1.2",
      "1.3",
      "2",
      "3",
      "3.1",
      "3.2",
      "3.3",
      "4",
    ]);
    expect(deepLevels).toStrictEqual([1, 2, 2, 2, 1, 1, 2, 2, 2, 1]);
  });
  test("forEach includes self", () => {
    let doc!: Doc;
    init(({ doc: doc2, node1, node3 }) => {
      doc = doc2;
      node1.append(...text(doc, "1.1", "1.2", "1.3"));
      node3.append(...text(doc, "3.1", "3.2", "3.3"));
    });
    const nodes: DocNode[] = [];
    const deepLevels: number[] = [];
    doc.root.descendants({ includeSelf: true }).forEach((node, deepLevel) => {
      nodes.push(node);
      deepLevels.push(deepLevel);
    });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual([
      undefined,
      "1",
      "1.1",
      "1.2",
      "1.3",
      "2",
      "3",
      "3.1",
      "3.2",
      "3.3",
      "4",
    ]);
  });
  test("find includes self", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    const node3 = doc.root
      .descendants({ includeSelf: true })
      .find((node): node is DocNode<typeof Text> => {
        nodes.push(node);
        return node.is(Text) && node.state.value.get() === "3";
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual([undefined, "1", "2", "3"]);
    expect(node3?.state.value.get()).toBe("3");
  });
  test("find excludes self", () => {
    let doc!: Doc;
    init(({ doc: doc2, node1, node3 }) => {
      doc = doc2;
      node1.append(...text(doc, "1.1", "1.2"));
      node3.append(...text(doc, "3.1"));
    });
    assertDoc(doc, ["1", "__1.1", "__1.2", "2", "3", "__3.1", "4"]);
    const nodes: DocNode[] = [];
    const node3_1 = doc.root
      .descendants()
      .find((node): node is DocNode<typeof Text> => {
        nodes.push(node);
        return node.is(Text) && node.state.value.get() === "3.1";
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1", "1.1", "1.2", "2", "3", "3.1"]);
    expect(node3_1?.state.value.get()).toBe("3.1");
  });
  test("find with type guard", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const isText = (node: DocNode) => node.is(Text);
    const node = doc.root.descendants().find(isText);
    expectTypeOf(node).toEqualTypeOf<DocNode<typeof Text> | undefined>();
  });
  test("find when there is no match should return undefined", () => {
    init(({ root }) => {
      const node = root.descendants().find(() => false);
      expect(node).toBeUndefined();
    });
  });
  test("is reusable (not like iterators)", () => {
    init(({ doc, root }) => {
      const descendants = root.descendants();
      descendants.forEach((node) => {
        (node as DocNode<typeof Text>).state.value.set(
          (current) => current + "+",
        );
      });
      assertDoc(doc, ["1+", "2+", "3+", "4+"]);
      descendants.forEach((node) => {
        (node as DocNode<typeof Text>).state.value.set(
          (current) => current + "+",
        );
      });
      assertDoc(doc, ["1++", "2++", "3++", "4++"]);
      const node1 = descendants.find((node) => node.is(Text));
      expect(node1?.state.value.get()).toBe("1++");
      const node2 = descendants.find(
        (node): node is DocNode<typeof Text> =>
          node.is(Text) && node.state.value.get() === "2++",
      );
      expect(node2?.state.value.get()).toBe("2++");
    });
  });
});

describe("ancestors", () => {
  test("works outside of doc.update", () => {
    let doc!: Doc;
    init(({ doc: doc2, node1, node3 }) => {
      doc = doc2;
      node1.append(...text(doc, "1.1", "1.2"));
      node3.append(...text(doc, "3.1"));
    });
    const nodes: DocNode[] = [];
    const indices: number[] = [];
    doc.root
      .first!.first!.ancestors({ includeSelf: true })
      .forEach((node, index) => {
        nodes.push(node);
        indices.push(index);
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1.1", "1", undefined]);
    expect(indices).toStrictEqual([0, 1, 2]);
  });

  test("forEach excludes self", () => {
    let doc!: Doc;
    init(({ doc: doc2, node1, node3 }) => {
      doc = doc2;
      node1.append(...text(doc, "1.1", "1.2"));
      node3.append(...text(doc, "3.1"));
    });
    const nodes: DocNode[] = [];
    const indices: number[] = [];
    doc.root.first!.first!.ancestors().forEach((node, index) => {
      nodes.push(node);
      indices.push(index);
    });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1", undefined]);
    // TO-DECIDE: I'm not sure if should be zero based with excludeSelf
    expect(indices).toStrictEqual([0, 1]);
  });

  test("find includes self", () => {
    let doc!: Doc;
    init(({ doc: doc2, node1 }) => {
      doc = doc2;
      node1.append(...text(doc, "1.1", "1.2"));
    });
    const nodes: DocNode[] = [];
    const node1 = doc.root
      .first!.first!.ancestors({ includeSelf: true })
      .find((node): node is DocNode<typeof Text> => {
        nodes.push(node);
        return node.is(Text) && node.state.value.get() === "1";
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1.1", "1"]);
    expect(node1?.state.value.get()).toBe("1");
  });

  test("find excludes self", () => {
    let doc!: Doc;
    init(({ doc: doc2, node1 }) => {
      doc = doc2;
      node1.append(...text(doc, "1.1", "1.2"));
    });
    const nodes: DocNode[] = [];
    const node1 = doc.root
      .first!.first!.ancestors()
      .find((node): node is DocNode<typeof Text> => {
        nodes.push(node);
        return node.is(Text) && node.state.value.get() === "1";
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1"]);
    expect(node1?.state.value.get()).toBe("1");
  });

  test("find with type guard", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "test"));
      const isText = (node: DocNode) => node.is(Text);
      const node = doc.root.first!.ancestors().find(isText);
      expectTypeOf(node).toEqualTypeOf<DocNode<typeof Text> | undefined>();
    });
  });

  test("find when there is no match should return undefined", () => {
    init(({ node1 }) => {
      const node = node1.ancestors().find(() => false);
      expect(node).toBeUndefined();
    });
  });

  test("is reusable (not like iterators)", () => {
    init(({ doc, root, node1 }) => {
      node1.append(...text(doc, "1.1", "1.2"));
      const ancestors = root.first!.first!.ancestors({ includeSelf: true });
      ancestors.forEach((node) => {
        if (node.is(Text)) {
          node.state.value.set((current) => current + "+");
        }
      });
      assertDoc(doc, ["1+", "__1.1+", "__1.2", "2", "3", "4"]);
      ancestors.forEach((node) => {
        if (node.is(Text)) {
          node.state.value.set((current) => current + "+");
        }
      });
      assertDoc(doc, ["1++", "__1.1++", "__1.2", "2", "3", "4"]);
      const node1found = ancestors.find((node) => node.is(Text));
      expect(node1found?.state.value.get()).toBe("1.1++");
      const node2found = ancestors.find((node) => node.is(Text));
      expect(node2found?.state.value.get()).toBe("1.1++");
    });
  });
});

describe("prevSiblings", () => {
  test("works outside of doc.update", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    doc.root.last!.prevSiblings({ includeSelf: true }).forEach((node) => {
      nodes.push(node);
    });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["4", "3", "2", "1"]);
  });

  test("forEach excludes self", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    doc.root.last!.prevSiblings().forEach((node) => {
      nodes.push(node);
    });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["3", "2", "1"]);
  });

  test("find includes self", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    const node2 = doc.root
      .last!.prevSiblings({ includeSelf: true })
      .find((node): node is DocNode<typeof Text> => {
        nodes.push(node);
        return node.is(Text) && node.state.value.get() === "2";
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["4", "3", "2"]);
    expect(node2?.state.value.get()).toBe("2");
  });

  test("find excludes self", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    const node2 = doc.root
      .last!.prevSiblings()
      .find((node): node is DocNode<typeof Text> => {
        nodes.push(node);
        return node.is(Text) && node.state.value.get() === "2";
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["3", "2"]);
    expect(node2?.state.value.get()).toBe("2");
  });

  test("find with type guard", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "test"));
      const isText = (node: DocNode) => node.is(Text);
      const node = doc.root.last!.prevSiblings().find(isText);
      expectTypeOf(node).toEqualTypeOf<DocNode<typeof Text> | undefined>();
    });
  });

  test("find when there is no match should return undefined", () => {
    init(({ node4 }) => {
      const node = node4.prevSiblings().find(() => false);
      expect(node).toBeUndefined();
    });
  });

  test("is reusable (not like iterators)", () => {
    init(({ doc, root }) => {
      const prevSiblings = root.last!.prevSiblings({ includeSelf: true });
      prevSiblings.forEach((node) => {
        (node as DocNode<typeof Text>).state.value.set(
          (current) => current + "+",
        );
      });
      assertDoc(doc, ["1+", "2+", "3+", "4+"]);
      prevSiblings.forEach((node) => {
        (node as DocNode<typeof Text>).state.value.set(
          (current) => current + "+",
        );
      });
      assertDoc(doc, ["1++", "2++", "3++", "4++"]);
    });
  });
});

describe("nextSiblings", () => {
  test("works outside of doc.update", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    doc.root.first!.nextSiblings({ includeSelf: true }).forEach((node) => {
      nodes.push(node);
    });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1", "2", "3", "4"]);
  });

  test("forEach excludes self", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    doc.root.first!.nextSiblings().forEach((node) => {
      nodes.push(node);
    });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["2", "3", "4"]);
  });

  test("find includes self", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    const node3 = doc.root
      .first!.nextSiblings({ includeSelf: true })
      .find((node): node is DocNode<typeof Text> => {
        nodes.push(node);
        return node.is(Text) && node.state.value.get() === "3";
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1", "2", "3"]);
    expect(node3?.state.value.get()).toBe("3");
  });

  test("find excludes self", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    const node3 = doc.root
      .first!.nextSiblings()
      .find((node): node is DocNode<typeof Text> => {
        nodes.push(node);
        return node.is(Text) && node.state.value.get() === "3";
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["2", "3"]);
    expect(node3?.state.value.get()).toBe("3");
  });

  test("find with type guard", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "test"));
      const isText = (node: DocNode) => node.is(Text);
      const node = doc.root.first!.nextSiblings().find(isText);
      expectTypeOf(node).toEqualTypeOf<DocNode<typeof Text> | undefined>();
    });
  });

  test("find when there is no match should return undefined", () => {
    init(({ node1 }) => {
      const node = node1.nextSiblings().find(() => false);
      expect(node).toBeUndefined();
    });
  });

  test("is reusable (not like iterators)", () => {
    init(({ doc, root }) => {
      const nextSiblings = root.first!.nextSiblings({ includeSelf: true });
      nextSiblings.forEach((node) => {
        (node as DocNode<typeof Text>).state.value.set(
          (current) => current + "+",
        );
      });
      assertDoc(doc, ["1+", "2+", "3+", "4+"]);
      nextSiblings.forEach((node) => {
        (node as DocNode<typeof Text>).state.value.set(
          (current) => current + "+",
        );
      });
      assertDoc(doc, ["1++", "2++", "3++", "4++"]);
    });
  });
});

describe("children", () => {
  test("works outside of doc.update", () => {
    let doc!: Doc;
    init(({ doc: doc2, node1, node3 }) => {
      doc = doc2;
      node1.append(...text(doc, "1.1", "1.2"));
      node3.append(...text(doc, "3.1", "3.2"));
    });
    const nodes: DocNode[] = [];
    doc.root.children().forEach((node) => {
      nodes.push(node);
    });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1", "2", "3", "4"]);
  });

  test("forEach excludes self", () => {
    let doc!: Doc;
    init(({ doc: doc2, node1, node3 }) => {
      doc = doc2;
      node1.append(...text(doc, "1.1", "1.2"));
      node3.append(...text(doc, "3.1", "3.2"));
    });
    const nodes: DocNode[] = [];
    doc.root.children().forEach((node) => {
      nodes.push(node);
    });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1", "2", "3", "4"]);
  });

  test("forEach includes self", () => {
    let doc!: Doc;
    init(({ doc: doc2, node1, node3 }) => {
      doc = doc2;
      node1.append(...text(doc, "1.1", "1.2"));
      node3.append(...text(doc, "3.1", "3.2"));
    });
    const nodes: DocNode[] = [];
    doc.root.children({ includeSelf: true }).forEach((node) => {
      nodes.push(node);
    });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual([undefined, "1", "2", "3", "4"]);
  });

  test("find includes self", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    const node3 = doc.root
      .children({ includeSelf: true })
      .find((node): node is DocNode<typeof Text> => {
        nodes.push(node);
        return node.is(Text) && node.state.value.get() === "3";
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual([undefined, "1", "2", "3"]);
    expect(node3?.state.value.get()).toBe("3");
  });

  test("find excludes self", () => {
    let doc!: Doc;
    init(({ doc: doc2, node1, node3 }) => {
      doc = doc2;
      node1.append(...text(doc, "1.1", "1.2"));
      node3.append(...text(doc, "3.1"));
    });
    const nodes: DocNode[] = [];
    const node3 = doc.root
      .children()
      .find((node): node is DocNode<typeof Text> => {
        nodes.push(node);
        return node.is(Text) && node.state.value.get() === "3";
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1", "2", "3"]);
    expect(node3?.state.value.get()).toBe("3");
  });

  test("find with type guard", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    const isText = (node: DocNode) => node.is(Text);
    const node = doc.root.children().find(isText);
    expectTypeOf(node).toEqualTypeOf<DocNode<typeof Text> | undefined>();
  });

  test("find when there is no match should return undefined", () => {
    init(({ root }) => {
      const node = root.children().find(() => false);
      expect(node).toBeUndefined();
    });
  });

  test("is reusable (not like iterators)", () => {
    init(({ doc, root }) => {
      const children = root.children();
      children.forEach((node) => {
        (node as DocNode<typeof Text>).state.value.set(
          (current) => current + "+",
        );
      });
      assertDoc(doc, ["1+", "2+", "3+", "4+"]);
      children.forEach((node) => {
        (node as DocNode<typeof Text>).state.value.set(
          (current) => current + "+",
        );
      });
      assertDoc(doc, ["1++", "2++", "3++", "4++"]);
      const node1 = children.find((node) => node.is(Text));
      expect(node1?.state.value.get()).toBe("1++");
      const node2 = children.find(
        (node): node is DocNode<typeof Text> =>
          node.is(Text) && node.state.value.get() === "2++",
      );
      expect(node2?.state.value.get()).toBe("2++");
    });
  });
});

// TODO: review
describe("to()", () => {
  test("forEach works correctly", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    doc.root.first!.to(doc.root.last!).forEach((node) => {
      nodes.push(node);
    });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1", "2", "3", "4"]);
  });

  test("find works correctly", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    const nodes: DocNode[] = [];
    const node3 = doc.root
      .first!.to(doc.root.last!)
      .find((node): node is DocNode<typeof Text> => {
        nodes.push(node);
        return node.is(Text) && node.state.value.get() === "3";
      });
    expect(
      nodes.map((n) => (n.is(Text) ? n.state.value.get() : undefined)),
    ).toStrictEqual(["1", "2", "3"]);
    expect(node3?.state.value.get()).toBe("3");
  });

  test("find with type guard", () => {
    const doc = new Doc({ type: "root", extensions: [TextExtension] });
    checkUndoManager(1, doc, () => {
      doc.root.append(...text(doc, "test"));
      const isText = (node: DocNode) => node.is(Text);
      const node = doc.root.first!.to(doc.root.last!).find(isText);
      expectTypeOf(node).toEqualTypeOf<DocNode<typeof Text> | undefined>();
    });
  });

  test("find when there is no match should return undefined", () => {
    init(({ node1 }) => {
      const node = node1.to(node1.next!).find(() => false);
      expect(node).toBeUndefined();
    });
  });

  test("is reusable (not like iterators)", () => {
    init(({ doc, root }) => {
      const range = root.first!.to(root.last!);
      range.forEach((node) => {
        (node as DocNode<typeof Text>).state.value.set(
          (current) => current + "+",
        );
      });
      assertDoc(doc, ["1+", "2+", "3+", "4+"]);
      range.forEach((node) => {
        (node as DocNode<typeof Text>).state.value.set(
          (current) => current + "+",
        );
      });
      assertDoc(doc, ["1++", "2++", "3++", "4++"]);
      const node1 = range.find((node) => node.is(Text));
      expect(node1?.state.value.get()).toBe("1++");
      const node2 = range.find(
        (node): node is DocNode<typeof Text> =>
          node.is(Text) && node.state.value.get() === "2++",
      );
      expect(node2?.state.value.get()).toBe("2++");
    });
  });

  test("throws error for invalid range", () => {
    let doc!: Doc;
    init(({ doc: doc2 }) => {
      doc = doc2;
    });
    assertError(
      doc,
      () => {
        doc.root.last!.to(doc.root.first!).forEach(() => {
          // This should throw an error
        });
      },
      `Node '${doc.root.first!.id}' is not a later sibling of '${doc.root.last!.id}'`,
    );
  });
});

test("DocNode.doc is readonly and not enumerable", () => {
  const doc = new Doc({ type: "root", extensions: [TextExtension] });
  const { root } = doc;
  expect(root.doc).toBe(doc);
  expect(Object.keys(root)).toStrictEqual([
    "id",
    "type",
    "_state",
    "parent",
    "prev",
    "next",
    "first",
    "last",
  ]);
  const newDoc = new Doc({ type: "root", extensions: [TextExtension] });
  // @ts-expect-error - readonly
  const fn = () => (root.doc = newDoc);
  expect(fn).toThrowError(
    "Cannot assign to read only property 'doc' of object '#<DocNode>'",
  );
});
