import {
  type ChangeEvent,
  type Doc,
  type DocNode,
  _INTERNAL_decodeOperations as decode,
} from "@docukit/docnode";
import { describe, expect, test } from "vitest";
import { checkUndoManager } from "../utils.js";
import {
  Paragraph,
  batchOf,
  bodies,
  concurrent,
  docWithParagraph,
  first,
  orderedServer,
  paragraph,
  textDoc,
} from "./utils.js";

type Body = DocNode<typeof Paragraph>["state"]["body"];

/** The paragraph after the first one. */
const second = (doc: Doc) => first(doc).next as DocNode<typeof Paragraph>;

/** Enter at `caret` of `node`: the letters after it go to a new paragraph. */
function enter(doc: Doc, node: DocNode<typeof Paragraph>, caret: number) {
  const next = doc.createNode(Paragraph);
  node.insertAfter(next);
  const body = node.state.body;
  body.moveTo(caret, body.length - caret, next.state.body, 0);
  return next;
}

/** Backspace at the start of `node`: its letters go to the one before. */
function backspace(node: DocNode<typeof Paragraph>) {
  const prev = node.prev as DocNode<typeof Paragraph>;
  const body = node.state.body;
  body.moveTo(0, body.length, prev.state.body, prev.state.body.length);
  node.delete();
}

/** The change event of `edit` on `doc`. */
function eventOf(doc: Doc, edit: () => void) {
  doc.forceCommit();
  let event: ChangeEvent | undefined;
  const stop = doc.onChange((e) => (event = e));
  edit();
  doc.forceCommit();
  stop();
  return event!;
}

describe("moving letters", () => {
  test("Enter splits a paragraph, and Backspace at the start joins it back", () => {
    const doc = textDoc();
    const node = paragraph(doc, "Hola mundo");
    const next = enter(doc, node, 4);
    expect(bodies(doc)).toStrictEqual(["Hola", " mundo"]);
    backspace(next);
    expect(bodies(doc)).toStrictEqual(["Hola mundo"]);
  });

  test("inside a text, the letters start at the target index after the move", () => {
    const { body } = docWithParagraph();
    body.insert(0, "abcdef");
    body.moveTo(1, 2, body, 3);
    expect(body.get()).toBe("adebcf");
    body.moveTo(3, 2, body, 0);
    expect(body.get()).toBe("bcadef");
    body.moveTo(0, 6, body, 0);
    body.moveTo(1, 0, body, 4);
    expect(body.get()).toBe("bcadef");
  });

  test.each<[string, (body: Body, other: Body) => void, string]>([
    [
      "a target index past the end",
      (body, other) => body.moveTo(0, 1, other, 3),
      "The target index 3 is out of the range of a text of length 2.",
    ],
    [
      "in the same text, the index counts the letters that move",
      (body) => body.moveTo(0, 2, body, 3),
      "The target index 5 is out of the range of a text of length 4.",
    ],
    [
      "a length that is not a count",
      (body, other) => body.moveTo(0, -1, other, 0),
      "Cannot move -1 letters.",
    ],
    [
      "a range past the end",
      (body, other) => body.moveTo(2, 3, other, 0),
      "The end 5 is out of the range of a text of length 4.",
    ],
  ])("throws on %s", (_, move, error) => {
    const doc = textDoc();
    const body = paragraph(doc, "abcd").state.body;
    const other = paragraph(doc, "xy").state.body;
    expect(() => move(body, other)).toThrowError(error);
    expect(bodies(doc)).toStrictEqual(["abcd", "xy"]);
  });

  test("only between texts of nodes in one document", () => {
    const doc = textDoc();
    const body = paragraph(doc, "ab").state.body;
    const detached = doc.createNode(Paragraph).state.body;
    const other = paragraph(textDoc(), "xy").state.body;
    const error =
      "Letters can only be moved between texts of nodes in the same document.";
    expect(() => body.moveTo(0, 1, detached, 0)).toThrowError(error);
    expect(() => detached.moveTo(0, 0, body, 0)).toThrowError(error);
    expect(() => body.moveTo(0, 1, other, 0)).toThrowError(error);
  });

  test("a move that changes nothing makes no batch", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "abc");
    doc.forceCommit();
    let events = 0;
    doc.onChange(() => events++);
    body.moveTo(1, 0, body, 0);
    body.moveTo(1, 2, body, 1);
    doc.forceCommit();
    expect(events).toBe(0);
  });
});

describe("rows of a move", () => {
  test("Enter: the letters keep their ids, into the empty text of the new node", () => {
    const { doc, node, body } = docWithParagraph();
    body.insert(0, "Hola mundo");
    const { operations, inverseOperations } = eventOf(doc, () =>
      enter(doc, node, 4),
    );
    expect(operations.slice(1)).toStrictEqual([
      [0, 1, "p", 0, -11],
      [2, -6, -1, 1, 0, 0, "body"],
    ]);
    // Back after "a", then the new node is deleted.
    expect(inverseOperations.slice(1)).toStrictEqual([
      [2, 1, 6, 0, -1],
      [1, 7],
    ]);
  });

  test("Backspace at the start is the inverse of Enter", () => {
    const { doc, node, body } = docWithParagraph();
    body.insert(0, "Hola mundo");
    const split = eventOf(doc, () => enter(doc, node, 4));
    const join = eventOf(doc, () => backspace(second(doc)));
    expect(join.operations).toStrictEqual(split.inverseOperations);
    expect(join.inverseOperations).toStrictEqual(split.operations);
  });

  test("inside a text, between its neighbours, and one letter", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "abcdef");
    const { operations, inverseOperations } = eventOf(doc, () =>
      body.moveTo(1, 2, body, 3),
    );
    // "bc" between "e" and "f"; back between "a" and "d".
    expect(operations.slice(1)).toStrictEqual([2, 1, 2, 0, 4, 5]);
    expect(inverseOperations.slice(1)).toStrictEqual([2, 1, 2, 0, -1, 3]);
    // "f", the head, to the start: before "a", made five letters before it.
    const one = batchOf(doc, () => body.moveTo(5, 1, body, 0));
    expect(one.slice(1)).toStrictEqual([2, 1, 0, 0, 0, -5]);
  });

  test("letters into an empty text of the root", () => {
    const decoded = decode(["a.0", 2, 1, 0, 0, 0, 0, "body"]);
    expect(decoded[0]).toStrictEqual([[2, "a.0", 0, 0, 0, 0, "body"]]);
  });
});

describe("changes of a move", () => {
  test("both texts report their splices, and both nodes are updated", () => {
    const doc = textDoc();
    const left = paragraph(doc, "Hola");
    const right = paragraph(doc, " mundo");
    doc.forceCommit();
    const { diff } = eventOf(doc, () => {
      right.state.body.moveTo(0, 6, left.state.body, 4);
      expect(left.state.body.changes()).toStrictEqual([
        { index: 4, deleted: 0, inserted: " mundo" },
      ]);
      expect(right.state.body.changes()).toStrictEqual([
        { index: 0, deleted: 6, inserted: "" },
      ]);
      expect(left.state.body.getPrev()).toStrictEqual([true, "Hola"]);
      expect(right.state.body.getPrev()).toStrictEqual([true, " mundo"]);
    });
    expect([...diff.updated]).toStrictEqual([right.id, left.id]);
  });

  test("inside a text, the letters leave and come back", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "abcdef");
    doc.forceCommit();
    eventOf(doc, () => {
      body.moveTo(1, 2, body, 3);
      expect(body.changes()).toStrictEqual([
        { index: 1, deleted: 2, inserted: "" },
        { index: 3, deleted: 0, inserted: "bc" },
      ]);
      expect(body.getPrev()).toStrictEqual([true, "abcdef"]);
    });
  });
});

describe("undo of a move", () => {
  test("Enter is undone and redone", () => {
    const doc = textDoc();
    checkUndoManager(3, doc, () => {
      const node = paragraph(doc, "Hola mundo");
      doc.forceCommit();
      const next = enter(doc, node, 4);
      doc.forceCommit();
      next.state.body.insert(0, "¡");
    });
  });

  test("Backspace at the start is undone and redone", () => {
    const doc = textDoc();
    checkUndoManager(3, doc, () => {
      const left = paragraph(doc, "Hola");
      const right = paragraph(doc, " mundo");
      doc.forceCommit();
      right.state.body.insert(6, "!");
      doc.forceCommit();
      backspace(right);
      left.state.body.delete(0, 1);
    });
  });

  test("moves inside a text and between texts are undone by ids", () => {
    const doc = textDoc();
    checkUndoManager(4, doc, () => {
      const left = paragraph(doc, "abcdef").state.body;
      const right = paragraph(doc, "xy").state.body;
      doc.forceCommit();
      left.moveTo(1, 2, left, 3);
      doc.forceCommit();
      left.moveTo(3, 2, left, 0);
      left.insert(1, "Z");
      doc.forceCommit();
      left.moveTo(0, 3, right, 1);
    });
  });

  test("a move between nodes inserted in the same transaction needs no inverse", () => {
    const doc = textDoc();
    checkUndoManager(2, doc, () => {
      const node = paragraph(doc, "Hola mundo");
      enter(doc, node, 4);
      doc.forceCommit();
      const other = paragraph(doc, "x");
      other.state.body.moveTo(0, 1, first(doc).state.body, 0);
    });
  });
});

describe("applying a move", () => {
  test("a remote Enter and Backspace land where they were made", () => {
    const { replica, edit } = orderedServer((doc) =>
      paragraph(doc, "Hola mundo"),
    );
    const [docA, docB] = [replica(), replica()];
    const apply = (batches: ReturnType<typeof edit>) => {
      for (const batch of batches) docB.applyOperations(batch);
      docB.forceCommit();
      expect(docB.toJSON()).toStrictEqual(docA.toJSON());
    };
    apply(edit(docA, () => enter(docA, first(docA), 4)));
    expect(bodies(docB)).toStrictEqual(["Hola", " mundo"]);
    apply(
      edit(docA, () =>
        first(docA).state.body.moveTo(1, 2, second(docA).state.body, 3),
      ),
    );
    expect(bodies(docB)).toStrictEqual(["Ha", " muolndo"]);
    apply(edit(docA, () => backspace(second(docA))));
    expect(bodies(docB)).toStrictEqual(["Ha muolndo"]);
    apply(
      edit(docA, () =>
        first(docA).state.body.moveTo(4, 3, first(docA).state.body, 0),
      ),
    );
    expect(bodies(docB)).toStrictEqual(["uolHa mndo"]);
  });

  test("an insert into the moved letters goes with them, in either order", () => {
    const setup = (doc: Doc) => paragraph(doc, "Hola mundo");
    const split = (body: Body, doc: Doc) => enter(doc, first(doc), 4);
    const type = (body: Body) => body.insert(7, "X");
    expect(concurrent(setup, split, type)).toStrictEqual(
      Array(3).fill(["Hola", " muXndo"]),
    );
    expect(concurrent(setup, type, split)).toStrictEqual(
      Array(3).fill(["Hola", " muXndo"]),
    );
  });

  /** A paragraph "abcdef", then one "xyz". */
  const setup = (doc: Doc) => {
    paragraph(doc, "abcdef");
    paragraph(doc, "xyz");
  };
  /** Moves `length` letters from `index` to `targetIndex` of "xyz". */
  const moveOut =
    (index: number, length: number, targetIndex: number) =>
    (body: Body, doc: Doc) =>
      body.moveTo(index, length, second(doc).state.body, targetIndex);

  test.each<[string, (body: Body, doc: Doc) => void, string[]]>([
    [
      "if prev is gone, before next",
      (_, doc) => second(doc).state.body.delete(0, 1),
      ["adef", "bcyz"],
    ],
    [
      "if prev and next are gone, nowhere",
      (_, doc) => second(doc).state.body.delete(0, 2),
      ["abcdef", "z"],
    ],
    [
      "if a border of the range is gone, nowhere",
      (body) => body.delete(2, 1),
      ["abdef", "xyz"],
    ],
    [
      "if the target node is gone, nowhere",
      (_, doc) => second(doc).delete(),
      ["abcdef"],
    ],
  ])("a move between texts: %s", (_, a, result) => {
    expect(concurrent(setup, a, moveOut(1, 2, 1))).toStrictEqual(
      Array(3).fill(result),
    );
  });

  test.each<[string, (body: Body, doc: Doc) => void, string[]]>([
    [
      "if it has letters now, to its start",
      (_, doc) => second(doc).state.body.insert(0, "Q"),
      ["a", "bcQ"],
    ],
    ["if its node is gone, nowhere", (_, doc) => second(doc).delete(), ["abc"]],
  ])("a move into an empty text: %s", (_, a, result) => {
    const setup = (doc: Doc) => {
      paragraph(doc, "abc");
      paragraph(doc);
    };
    const move = (body: Body, doc: Doc) =>
      body.moveTo(1, 2, second(doc).state.body, 0);
    expect(concurrent(setup, a, move)).toStrictEqual(Array(3).fill(result));
  });

  test("a move into the moved letters is dropped", () => {
    // A moves "x" into "abcdef"; B moves "abc" after "x" at once.
    const a = (body: Body, doc: Doc) =>
      second(doc).state.body.moveTo(0, 1, body, 2);
    expect(concurrent(setup, a, moveOut(0, 3, 1))).toStrictEqual(
      Array(3).fill(["abxcdef", "yz"]),
    );
  });

  test.each<[string, (body: Body) => void, (body: Body) => void, string]>([
    [
      "right",
      (body) => body.insert(6, "!"),
      (body) => body.moveTo(1, 2, body, 3),
      "adebcf!",
    ],
    [
      "left",
      (body) => body.insert(0, "!"),
      (body) => body.moveTo(3, 2, body, 1),
      "!adebcf",
    ],
    // "d" is gone: before "e", right where the letters are.
    [
      "to where the letters are",
      (body) => body.delete(3, 1),
      (body) => body.moveTo(1, 2, body, 2),
      "abcef",
    ],
  ])("a move inside a text, %s", (_, a, b, result) => {
    const setup = (doc: Doc) => paragraph(doc, "abcdef");
    expect(concurrent(setup, a, b)).toStrictEqual(Array(3).fill([result]));
  });
});
