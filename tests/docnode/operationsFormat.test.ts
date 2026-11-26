import {
  Doc,
  mergeOperations,
  type Operations,
  _INTERNAL_decodeOperations as decode,
} from "@docukit/docnode";
import { upgradeOperations } from "@docukit/docnode/compat";
import { describe, expect, test } from "vitest";
import {
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
    expect(batch).toStrictEqual([
      doc.root.first!.id,
      [0, [[1, "text"]], 0, 0, 0],
      [-9, [1], ["value"], ["a"]],
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
      [0, [[1, "text"]], 0, -1, 0],
      [-9, [1], ["value"], ["b"]],
    ]);
    expect(c!.rows).toStrictEqual(b!.rows.with(1, [-9, [1], ["value"], ["c"]]));
    expect(c!.head).not.toBe(b!.head);
  });

  test("nodes made one after the other are a run, counted by 1 in the patch", () => {
    const doc = textDoc();
    const [batch] = batchesOf(doc, () =>
      doc.root.append(...text(doc, "a", "b", "c")),
    );
    expect(batch).toStrictEqual([
      doc.root.first!.id,
      [0, [[1, "text", 3]], 0, 0, 0],
      [-9, [1, 1, 1], ["value", "value", "value"], ["a", "b", "c"]],
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
      0,
      0,
      0,
    ]);
  });

  test("delete and move rows, nodes before the head's are negative", () => {
    const doc = textDoc();
    doc.root.append(...text(doc, "a", "b", "c"));
    const [first, last] = [doc.root.first!, doc.root.last!];
    const batches = batchesOf(
      doc,
      commits(
        doc,
        () => last.move(first, "before"),
        () => first.to(doc.root.last!).delete(),
      ),
    );
    expect(batches).toStrictEqual([
      [last.id, [2, 1, 0, 0, 0, -2]],
      [first.id, [1, 1, 2]],
    ]);
    assertDoc(doc, ["c"]);
  });

  test("other nodes are whole ids, and a batch without nodes of a session has no head", () => {
    const doc = textDoc();
    const replica = Doc.fromJSON(config, doc.toJSON());
    replica.forceCommit();
    const [inserted] = batchesOf(doc, () => doc.root.append(...text(doc, "a")));
    replica.applyOperations(inserted!);
    const [edited] = batchesOf(replica, () => {
      replica.root.append(...text(replica, "b"));
      const node = replica.root.first!;
      if (node.is(Text)) node.state.value.set("A");
    });
    expect(edited).toStrictEqual([
      replica.root.last!.id,
      [0, [[1, "text"]], 0, doc.root.first!.id, 0],
      [-9, [1, doc.root.first!.id], ["value", "value"], ["b", "A"]],
    ]);

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
      [0, [["n1", "text"]], 0, 0, 0],
      [-9, ["n1"], ["value"], ["x"]],
    ]);
  });

  test("an id of the head's session that its generator would not write stays whole", () => {
    expect(
      mergeOperations(["S.0", [1, 1, 0]], ["", [1, "S.-0", "S.0.1"]]),
    ).toStrictEqual(["S.0", [1, 1, 0], [1, "S.-0", "S.0.1"]]);
  });

  test("a batch with only a state patch takes its head from it", () => {
    const doc = textDoc();
    doc.root.append(...text(doc, "a", "b"));
    const second = doc.root.last!;
    const [batch] = batchesOf(doc, () => {
      if (second.is(Text)) second.state.value.set("B");
    });
    expect(batch).toStrictEqual([second.id, [-9, [1], ["value"], ["B"]]]);
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

describe("upgradeOperations", () => {
  test("a batch of the previous format applies as it did", () => {
    const doc = textDoc();
    const id = doc.createNode(Text).id;
    doc.applyOperations(
      upgradeOperations([
        [[0, [[id, "text"]], 0, 0, 0]],
        { [id]: { value: '"old"' } },
      ]),
    );
    doc.forceCommit();
    assertDoc(doc, ["old"]);
  });

  test("a batch of the current format is returned as it is", () => {
    const batch: Operations = ["", [1, "a", 0]];
    expect(upgradeOperations(batch)).toBe(batch);
  });
});
