import {
  type Operations,
  mergeOperations,
  _INTERNAL_decodeOperations as decode,
} from "@docukit/docnode";
import { describe, expect, test } from "vitest";
import {
  Paragraph,
  batchOf,
  bodies,
  docWithParagraph,
  first,
  orderedServer,
  paragraph,
  textDoc,
} from "./utils.js";

/** The rows of the batch of `edit`, without the head. */
const rowsOf = (...args: Parameters<typeof batchOf>) =>
  batchOf(...args).slice(1);

describe("letter rows (design table 4.3)", () => {
  test("a key after the letter typed before", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "Y");
    body.insert(1, "z".repeat(4019));
    body.insert(0, "P");
    expect(rowsOf(doc, () => body.insert(1, "a"))).toStrictEqual([
      "-1,-4021|a",
    ]);
  });

  test("a key inside a run leaves out next", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "x".repeat(1000));
    expect(rowsOf(doc, () => body.insert(189, "a"))).toStrictEqual(["-812|a"]);
  });

  test("a key at the end of the text", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "b");
    expect(rowsOf(doc, () => body.insert(1, "a"))).toStrictEqual(["-1,0|a"]);
  });

  test("a key at the start of the text", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "abcde");
    expect(rowsOf(doc, () => body.insert(0, "a"))).toStrictEqual([",-5|a"]);
  });

  test("a key in an empty text", () => {
    const { doc, body } = docWithParagraph();
    for (let i = 0; i < 8; i++) paragraph(doc);
    expect(rowsOf(doc, () => body.insert(0, "a"))).toStrictEqual([
      "@-9,body|a",
    ]);
  });

  test("deleting a letter, or a range", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "abc");
    const one = batchOf(doc, () => body.delete(1, 1));
    expect(one).toStrictEqual([one[0], 1, 1]);
    body.insert(0, "L");
    body.insert(1, "f".repeat(29));
    body.insert(0, "F");
    const range = batchOf(doc, () => body.delete(0, 2));
    expect(range).toStrictEqual([range[0], 1, 1, -30]);
  });

  test("a new node with text", () => {
    // Deviation from the table: the head is the first letter, so the node is
    // -1 (the table wrote the node as the head).
    const doc = textDoc();
    expect(rowsOf(doc, () => paragraph(doc, "Hola"))).toStrictEqual([
      [0, -1, "p"],
      "@-1,body|Hola",
    ]);
  });
});

describe("letter rows", () => {
  test("the head is the first new letter", () => {
    const { doc, node, body } = docWithParagraph();
    body.insert(0, "ab");
    const batch = batchOf(doc, () => {
      node.state.bold.set(true);
      body.delete(0, 1);
      body.insert(1, "c");
    });
    const letter = decode(batch)[0][1]!;
    expect(batch[0]).toBe(letter[1]);
    expect(batch.slice(1)).toStrictEqual([
      [1, -2],
      "-1,0|c",
      [3, -3, "bold", 1],
    ]);
  });

  test("a row whose letters do not follow the row before says where they start", () => {
    const { doc, body } = docWithParagraph();
    body.insert(0, "abc");
    const rows = rowsOf(doc, () => {
      body.insert(0, "X");
      doc.createNode(Paragraph);
      body.insert(4, "Y");
    });
    expect(rows).toStrictEqual([",-3|X", "3>-1,0|Y"]);
  });

  test("letters of another session are whole ids", () => {
    const { replica, edit } = orderedServer((doc) => paragraph(doc, "ab"));
    const doc = replica();
    const [batch] = edit(doc, () => first(doc).state.body.insert(1, "x"));
    // "a" and "b" were made one after the other: `next` is left out.
    const prev = decode(batch!)[0][0]![2];
    expect(prev).toContain(".");
    expect(batch!.slice(1)).toStrictEqual([`${prev}|x`]);
  });

  test("merged batches keep where each insert's letters start", () => {
    const { doc, body } = docWithParagraph();
    const a = batchOf(doc, () => body.insert(0, "a"));
    doc.createNode(Paragraph);
    const b = batchOf(doc, () => body.insert(1, "b"));
    const merged = mergeOperations(a, b);
    expect(merged.slice(1)).toStrictEqual([":1,3>@-1,body|ab"]);
    expect(decode(merged)[0]).toStrictEqual([...decode(a)[0], ...decode(b)[0]]);
  });

  test.each<[string, Operations]>([
    ["a row without its letters", ["a.0", "-1,0"]],
    ["a row of no letters", ["a.0", "-1,0|"]],
    ["letters without a head", ["", "-1,0|a"]],
    ["letters past the last clock", ["a.zzzzzzzz", "-1,0|ab"]],
    ["a letter that is not a number", ["a.0", "x,0|a"]],
    ["a key that is not named", ["a.0", "@1|a"]],
    ["no letter after prev", ["a.0", "b.!|a"]],
    ["no letter after the last clock", ["a.0", "b.zzzzzzzz|a"]],
    ["a start that is not a letter", ["a.0", "0>-1,0|a"]],
  ])("an invalid batch: %s", (_, batch) => {
    expect(() => decode(batch)).toThrowError("Invalid operations");
  });

  test("the text after the first '|' is read as it is", () => {
    expect(decode(["a.5", "a.1>@0,key|x|,>@"])[0]).toStrictEqual([
      [4, "a.1", 0, 0, "x|,>@", 0, "key"],
    ]);
    expect(decode(["a.5", "-1|b", ",-2|c"])[0]).toStrictEqual([
      [4, "a.5", "a.4", "a.5", "b"],
      [4, "a.6", 0, "a.3", "c"],
    ]);
  });
});

describe("letter rows of an undo", () => {
  /** A text "abcd" whose letters are four runs, deleted. */
  function deletedRuns() {
    const { doc, body } = docWithParagraph(0);
    body.insert(0, "ac");
    doc.forceCommit();
    body.insert(1, "b");
    doc.forceCommit();
    body.insert(3, "d");
    doc.forceCommit();
    body.delete(0, 4);
    doc.forceCommit();
    return { doc, body };
  }

  test("letters of many runs come back in one row", () => {
    const { doc, body } = deletedRuns();
    expect(rowsOf(doc, () => doc.undoManager.undo())).toStrictEqual([
      ":1,3:1,2:1,4>@-1,body|abcd",
    ]);
    expect(body.get()).toBe("abcd");
  });

  test("their redo is one delete", () => {
    const { doc, body } = deletedRuns();
    doc.undoManager.undo();
    expect(batchOf(doc, () => doc.undoManager.redo()).slice(1)).toStrictEqual([
      1, 1, 4,
    ]);
    expect(body.get()).toBe("");
  });

  test("letters of many runs come back between their neighbours", () => {
    const { doc, body } = docWithParagraph(0);
    body.insert(0, "acZ");
    doc.forceCommit();
    body.insert(1, "b");
    doc.forceCommit();
    body.delete(0, 3);
    doc.forceCommit();
    expect(rowsOf(doc, () => doc.undoManager.undo())).toStrictEqual([
      ":1,4:1,2>,3|abc",
    ]);
    expect(body.get()).toBe("abcZ");
  });

  test("a run of another session starts at its whole id", () => {
    const { replica, edit, send } = orderedServer((doc) =>
      paragraph(doc, "hi"),
    );
    const doc = replica({
      undoManager: { maxUndoSteps: 10, mergeInterval: 0 },
    });
    const [typed] = edit(doc, (doc) => first(doc).state.body.insert(1, "XY"));
    send([typed!]);
    doc.forceCommit();
    first(doc).state.body.delete(0, 4);
    doc.forceCommit();
    const batch = batchOf(doc, () => doc.undoManager.undo());
    // "h" and "i" are of the server's session, the head's; "XY" are not.
    const xy = String(decode(batch)[0][1]![1]);
    expect(xy).toContain(".");
    expect(batch.slice(1)).toStrictEqual([`:1,${xy}:2,2>@-1,body|hXYi`]);
    expect(bodies(doc)).toStrictEqual(["hXYi"]);
  });

  test.each<[string, Operations]>([
    ["a run without its length", ["a.0", "1,3>-1,0|ab"]],
    ["a length that is not a number", ["a.0", ":x,3>-1,0|ab"]],
    ["a run of no letters", ["a.0", ":0,3>-1,0|ab"]],
    ["a last run of no letters", ["a.0", ":2,3>-1,0|ab"]],
  ])("an invalid batch: %s", (_, batch) => {
    expect(() => decode(batch)).toThrowError("Invalid operations");
  });

  test("the later runs of a row go after the run before", () => {
    expect(decode(["a.5", ":1,b.2:2,>a.1|xyzw"])[0]).toStrictEqual([
      [4, "a.5", "a.1", "a.2", "x"],
      [4, "b.2", "a.5", "a.2", "yz"],
      [4, "b.4", "b.3", "a.2", "w"],
    ]);
  });
});
