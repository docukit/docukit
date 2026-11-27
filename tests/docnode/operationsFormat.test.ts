import {
  Doc,
  defineNode,
  defineState,
  mergeOperations,
  type Operations,
  _INTERNAL_decodeOperations as decode,
} from "@docukit/docnode";
import { upgradeOperations } from "@docukit/docnode/compat";
import { describe, expect, test } from "vitest";
import {
  TestExtension,
  TestNode,
  Text,
  assertDoc,
  text,
  textDoc,
  textDocConfig as config,
} from "./utils.js";

/** The ids of the root's children. */
const childIds = (doc: Doc) => {
  const ids: string[] = [];
  doc.root.children().forEach((node) => ids.push(node.id));
  return ids;
};

/** The batches `doc` writes while `edit` runs, one per commit. */
const batchesOf = (doc: Doc, edit: () => void) => {
  doc.forceCommit();
  const batches: Operations[] = [];
  const stop = doc.onChange(({ operations }) => batches.push(operations));
  edit();
  doc.forceCommit();
  stop();
  return batches;
};

/** Each change of `edit` as its own commit. */
const commits =
  (doc: Doc, ...edits: (() => void)[]) =>
  () =>
    edits.forEach((edit) => {
      edit();
      doc.forceCommit();
    });

describe("operations format", () => {
  test("the head is the first node's id, and its session's nodes are numbers", () => {
    const doc = textDoc();
    const [batch] = batchesOf(doc, () => doc.root.append(...text(doc, "a")));
    // One node is inserted without its list, and without the zeros of no
    // parent and no siblings.
    expect(batch).toStrictEqual([
      doc.root.first!.id,
      [0, 1, "text"],
      [3, 1, "value", "a"],
    ]);
  });

  test("inserting after the node inserted before writes the same rows", () => {
    const doc = textDoc();
    doc.root.append(...text(doc, "a"));
    const batches = batchesOf(
      doc,
      commits(
        doc,
        () => doc.root.append(...text(doc, "b")),
        () => doc.root.append(...text(doc, "c")),
      ),
    );
    const [b, c] = batches.map(([head, ...rows]) => ({ head, rows }));
    expect(b!.rows).toStrictEqual([
      [0, 1, "text", 0, -1],
      [3, 1, "value", "b"],
    ]);
    expect(c!.rows).toStrictEqual([b!.rows[0], [3, 1, "value", "c"]]);
    expect(c!.head).not.toBe(b!.head);
  });

  test("nodes made one after the other are a run, in the insert and in the patch", () => {
    const doc = textDoc();
    const [batch] = batchesOf(doc, () =>
      doc.root.append(...text(doc, "a", "b", "c")),
    );
    expect(batch).toStrictEqual([
      doc.root.first!.id,
      [0, [[1, "text", 3]]],
      [3, [1, 3], "value", ["a", "b", "c"]],
    ]);
    expect(decode(batch!)[0][0]![1]).toStrictEqual(
      childIds(doc).map((id) => [id, "text"]),
    );
  });

  test("a run stops where the clocks do not follow", () => {
    const doc = textDoc();
    const [a, b, c] = text(doc, "a", "b", "c");
    const [batch] = batchesOf(doc, () => doc.root.append(c!, a!, b!));
    // The head is `c`, the third node made: `a` and `b` are before it.
    expect(batch![1]).toStrictEqual([
      0,
      [
        [1, "text"],
        [-2, "text", 2],
      ],
    ]);
  });

  test("a number node of the patch is its difference from the one before", () => {
    const doc = new Doc({ type: "root", extensions: [TestExtension] });
    const nodes = [1, 2, 3, 4].map(() => doc.createNode(TestNode));
    const [batch] = batchesOf(doc, () => {
      nodes.forEach((node, at) => {
        node.state.string.set(`${at}`);
        node.state.number.set(at + 1);
      });
      doc.root.append(...nodes);
    });
    // A run writes its first node again for each key: 0 from the one before.
    expect(batch![2]).toStrictEqual([
      3,
      [1, 4],
      "string",
      ["0", "1", "2", "3"],
      [0, 4],
      "number",
      [1, 2, 3, 4],
    ]);

    // The second node has other keys than the first: no run.
    const [first, second, , fourth] = nodes;
    const [edited] = batchesOf(doc, () => {
      first!.state.string.set("a");
      first!.state.number.set(5);
      second!.state.number.set(6);
      fourth!.state.number.set(8);
    });
    expect(edited).toStrictEqual([
      first!.id,
      [3, 1, "string", "a", 0, "number", 5, 1, "number", 6, 2, "number", 8],
    ]);
  });

  test("a batch of one row has no brackets, and nodes before the head's are negative", () => {
    const doc = textDoc();
    doc.root.append(...text(doc, "a", "b", "c"));
    const [first, second, last] = [
      doc.root.first!,
      doc.root.first!.next!,
      doc.root.last!,
    ];
    const batches = batchesOf(
      doc,
      commits(
        doc,
        () => last.move(first, "before"),
        () => first.to(doc.root.last!).delete(),
      ),
    );
    expect(batches).toStrictEqual([
      [last.id, 2, 1, 0, 0, 0, -2],
      [first.id, 1, 1, 2],
    ]);
    expect(decode(batches[1]!)).toStrictEqual([
      [[1, first.id, second.id]],
      new Map(),
    ]);
    assertDoc(doc, ["c"]);
  });

  test("other nodes are whole ids, and a batch without nodes of a session has no head", () => {
    const doc = textDoc();
    const replica = Doc.fromJSON(config, doc.toJSON());
    replica.forceCommit();
    const [inserted] = batchesOf(doc, () =>
      doc.root.append(...text(doc, "a", "b")),
    );
    replica.applyOperations(inserted!);
    const [edited] = batchesOf(replica, () => {
      replica.root.append(...text(replica, "c"));
      replica.root.children().forEach((node) => {
        if (node.is(Text) && node.id !== replica.root.last!.id)
          node.state.value.set(node.state.value.get().toUpperCase());
      });
    });
    const [a, b] = childIds(doc);
    expect(edited).toStrictEqual([
      replica.root.last!.id,
      [0, 1, "text", 0, b!],
      [3, 1, "value", "c", [a!, 2], "value", ["A", "B"]],
    ]);
    doc.applyOperations(edited!);
    doc.forceCommit();
    assertDoc(doc, ["A", "B", "c"]);

    let n = 0;
    const custom = new Doc({
      ...config,
      nodeIdGenerator: { generate: () => `n${n++}`, validate: () => true },
    });
    const [plain] = batchesOf(custom, () =>
      custom.root.append(...text(custom, "x")),
    );
    expect(plain).toStrictEqual([
      "",
      [0, "n1", "text"],
      [3, "n1", "value", "x"],
    ]);
  });

  test("an id whose session is longer than 64 characters is written whole", () => {
    /** The batch of two nodes of a custom generator, of a session of `length`. */
    const batchOfSession = (length: number) => {
      const session = "s".repeat(length);
      let n = 0;
      const doc = new Doc({
        ...config,
        nodeIdGenerator: {
          generate: () => `${session}.${n++}`,
          validate: () => true,
        },
      });
      return batchesOf(doc, () => doc.root.append(...text(doc, "a", "b")))[0]!;
    };
    const a = `${"s".repeat(64)}.1`;
    expect(batchOfSession(64)).toStrictEqual([
      a,
      [0, [[1, "text", 2]]],
      [3, [1, 2], "value", ["a", "b"]],
    ]);
    const [long, longer] = [`${"s".repeat(65)}.1`, `${"s".repeat(65)}.2`];
    const batch = batchOfSession(65);
    expect(batch).toStrictEqual([
      "",
      [
        0,
        [
          [long, "text"],
          [longer, "text"],
        ],
      ],
      [3, long, "value", "a", longer, "value", "b"],
    ]);

    // A document with sessions of its own writes them whole too.
    const doc = textDoc();
    doc.applyOperations(batch);
    doc.forceCommit();
    assertDoc(doc, ["a", "b"]);
    const [deleted] = batchesOf(doc, () =>
      doc.root.first!.to(doc.root.last!).delete(),
    );
    expect(deleted).toStrictEqual(["", 1, long, longer]);
  });

  test("an id of the head's session that its generator would not write stays whole", () => {
    expect(
      mergeOperations(["S.0", 1, 1], ["", 1, "S.-0", "S.0.1"]),
    ).toStrictEqual(["S.0", [1, 1], [1, "S.-0", "S.0.1"]]);
  });

  test("a batch with only a state patch takes its head from it", () => {
    const doc = textDoc();
    doc.root.append(...text(doc, "a", "b"));
    const second = doc.root.last!;
    const [batch] = batchesOf(doc, () => {
      if (second.is(Text)) second.state.value.set("B");
    });
    expect(batch).toStrictEqual([second.id, [3, 1, "value", "B"]]);
  });

  test("the change event writes each batch once, when it is read", () => {
    const doc = textDoc();
    const read: Operations[] = [];
    doc.onChange((event) => read.push(event.operations, event.operations));
    doc.root.append(...text(doc, "a"));
    doc.forceCommit();
    expect(read[0]).toBe(read[1]);
  });
});

describe("a batch that does not follow the format", () => {
  /** A batch with `head` and `rows` as they come, whatever their shape. */
  const batch = (head: unknown, ...rows: unknown[]) => {
    const parts: Operations = [""];
    [head, ...rows].forEach((part, at) => Reflect.set(parts, at, part));
    return parts;
  };

  test.each([
    [batch([], {}), "These operations are in the previous format"],
    [batch("s.0", [0, [[1, "text", 0]], 0, 0, 0]), "a run of 0 nodes"],
    [batch("s.0", [0, [[1, "text", 1e9]], 0, 0, 0]), "more than 1000000"],
    [batch("", [0, [["x", "text", 3]], 0, 0, 0]), "a run of 3 nodes from 'x'"],
    [batch("", [1, 5, 0]), "5 is not a node of the head's session"],
    [batch("s.0", [1, -5, 0]), "-5 is not a node of the head's session"],
    [batch("s.zzzzzzzz", [0, [[1, "text", 2]]]), "a run of 2 nodes"],
    [batch("", 1, 5), "5 is not a node of the head's session"],
    [batch("s.0", 0, 1, 2), "its row 1 is not an operation"],
    [batch("s.0", [0, ["text"]]), "its row 1 is not an operation"],
    [batch("s.0", [3, 1, "value"]), "not triples of node, key and value"],
    [batch("s.0", [3, 1, 2, "a"]), "a key that is not a string"],
    [batch("s.0", [3, 1, "__proto__", {}]), "every object has"],
    [batch("s.0", [3, [1, 1], "value", ["a"]]), "a run of 1 nodes"],
    [batch("s.0", [3, [1, 2], "value", ["a"]]), "not have a value for each"],
    [batch("s.0", [3, [1, 2], "value", "ab"]), "not have a value for each"],
    [batch("s.0", [7]), "its row 1 is not an operation"],
    [batch("s.0", 7), "its row 1 is not an operation"],
    [batch("s.0", "x"), "its row 1 is not an operation"],
    [batch("", [0, [["__proto__", "text"]], 0, 0, 0]), "every object has"],
    [batch("s.0", [3, 1, "value", "a"], [1, 1]), "its row 1"],
    [batch("s.0", [0, []]), "its row 1 is not an operation"],
    [batch("s.0", [0, [[1, "text", 2, 0]]]), "its row 1 is not an operation"],
    [batch("s.0", [0, [[1, "text"]], 0, 0, 0, 0]), "row 1 has items after"],
    [batch("s.0", [0, 1, "text", 0, 0, 0, 0]), "row 1 has items after"],
    [batch("s.0", [1, 1, 0, 0]), "row 1 has items after"],
    [batch("s.0", [2, 1, 0, 0, 0, 0, 0]), "row 1 has items after"],
    [batch("s.0", 1, 1, 0, 0), "row 1 has items after"],
    [batch("s.0", [3, [1, 2, 0], "value", ["a", "b"]]), "not a node and a"],
    // Each node counts, those before a run too, before the run is expanded.
    [
      batch("s.9", [
        0,
        [
          [-1, "text"],
          [-2, "text"],
          [1, "text", 999_999],
        ],
      ]),
      "more than 1000000",
    ],
    [
      batch(
        "s.9",
        [0, -1, "text"],
        [0, -2, "text"],
        [0, [[1, "text", 1e6 - 1]]],
      ),
      "more than 1000000",
    ],
    [batch("s.0", 0, [[1, "text", 1e6 + 1]]), "more than 1000000"],
  ])("%j throws and changes nothing", (operations, message) => {
    const doc = textDoc();
    doc.root.append(...text(doc, "a"));
    doc.forceCommit();
    const before = doc.toJSON();
    expect(() => doc.applyOperations(operations)).toThrowError(message);
    doc.forceCommit();
    expect(doc.toJSON()).toStrictEqual(before);
  });

  test("a run or a head with a session longer than 64 characters throws before it is expanded", () => {
    // Expanded, each of a million ids would have the million characters.
    const id = `${"s".repeat(1e6)}.0`;
    const doc = textDoc();
    doc.root.append(...text(doc, "a"));
    doc.forceCommit();
    const before = doc.toJSON();
    const broken: [Operations, string][] = [
      [[id, [0, [[1, "text", 1e6]]]], "1 is not a node of the head's session"],
      [["", [0, [[id, "text", 1e6]]]], "a run of 1000000 nodes"],
      [["", [3, [id, 2], "value", ["a", "b"]]], "a run of 2 nodes"],
    ];
    for (const [operations, message] of broken)
      expect(() => doc.applyOperations(operations)).toThrowError(message);
    doc.forceCommit();
    expect(doc.toJSON()).toStrictEqual(before);
    // Written whole, the same id is a node like any other.
    doc.applyOperations([id, 0, id, "text"]);
    doc.forceCommit();
    expect(doc.root.last!.id).toBe(id);
  });

  test.each([
    ["a batch", () => decode(["", [3, "__proto__", "value", "a"]])],
    [
      "a custom generator",
      () => {
        let made = 0;
        // The root first, then a node with an id that every object has.
        const generate = () => (made++ === 0 ? "root" : "toString");
        const doc = new Doc({
          ...config,
          nodeIdGenerator: { generate, validate: () => true },
        });
        doc.createNode(Text);
      },
    ],
    [
      "a stored document",
      () => {
        const doc = textDoc();
        doc.root.append(...text(doc, "a"));
        doc.forceCommit();
        const json = doc.toJSON();
        Reflect.set(json, 9, ["__proto__"]);
        Doc.fromJSON(config, json);
      },
    ],
    [
      "an old batch's id",
      () => upgradeOperations([[], Object.fromEntries([["__proto__", {}]])]),
    ],
    [
      "an old batch's state key",
      () =>
        upgradeOperations([
          [],
          { a: Object.fromEntries([["__proto__", "1"]]) },
        ]),
    ],
  ])("a key that every object has, from %s, throws", (_, load) => {
    expect(load).toThrowError("is a key that every object has");
    expect(Object.prototype).not.toHaveProperty("value");
  });
});

describe("applying operations", () => {
  /** A node whose state is any JSON value, `null` when unset. */
  const Maybe = defineNode({
    type: "maybe",
    state: { value: defineState({ fromJSON: (json) => json ?? null }) },
  });

  /** A document with one `Maybe` node, and a replica loaded from it. */
  const maybeDocs = (register?: (doc: Doc) => void) => {
    const extension = register
      ? { nodes: [Maybe], register }
      : { nodes: [Maybe] };
    const maybeConfig = { type: "root", extensions: [extension] };
    const sender = new Doc(maybeConfig);
    const node = sender.createNode(Maybe);
    sender.root.append(node);
    sender.forceCommit();
    const receiver = Doc.fromJSON(maybeConfig, sender.toJSON());
    receiver.forceCommit();
    return { sender, node, receiver };
  };

  test("the inverse of a key changed twice in a transaction is its first value, even null", () => {
    // The second batch is applied in the same transaction as the first.
    let next: Operations | undefined;
    const { sender, node, receiver } = maybeDocs((doc) =>
      doc.onNormalize(() => {
        const batch = next;
        next = undefined;
        if (batch) doc.applyOperations(batch);
      }),
    );
    const [first, second] = batchesOf(
      sender,
      commits(
        sender,
        () => node.state.value.set("first"),
        () => node.state.value.set("second"),
      ),
    );
    const inverses: Operations[] = [];
    receiver.onChange(({ inverseOperations }) =>
      inverses.push(inverseOperations),
    );
    next = second;
    receiver.applyOperations(first!);
    expect(inverses).toHaveLength(1);
    receiver.applyOperations(inverses[0]!);
    receiver.forceCommit();
    const undone = receiver.getNodeById(node.id);
    if (!undone?.is(Maybe)) throw new Error("The node is a Maybe");
    expect(undone.state.value.get()).toBe(null);
  });

  test("a value with an own `__proto__` key differs from one without it", () => {
    const { sender, node, receiver } = maybeDocs();
    const [first, second] = batchesOf(
      sender,
      commits(
        sender,
        () => node.state.value.set(Object.fromEntries([["__proto__", {}]])),
        () => node.state.value.set({ other: {} }),
      ),
    );
    receiver.applyOperations(first!);
    receiver.applyOperations(second!);
    receiver.forceCommit();
    expect(receiver.toJSON()).toStrictEqual(sender.toJSON());
  });
});

describe("upgradeOperations", () => {
  test("a batch of the previous format applies as it did", () => {
    const doc = textDoc();
    const id = doc.createNode(Text).id;
    const upgraded = upgradeOperations([
      [[0, [[id, "text"]], 0, 0, 0]],
      { [id]: { value: '"old"' } },
    ]);
    expect(upgraded).toStrictEqual([
      id,
      [0, 1, "text"],
      [3, 1, "value", "old"],
    ]);
    doc.applyOperations(upgraded);
    doc.forceCommit();
    assertDoc(doc, ["old"]);
  });

  test("a batch of the current format is returned as it is", () => {
    const batch: Operations = ["", 1, "a"];
    expect(upgradeOperations(batch)).toBe(batch);
  });
});
