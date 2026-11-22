import { Doc } from "@docukit/docnode";
import { describe, expect, test } from "vitest";

import {
  config,
  flat,
  Paragraph,
  receive,
  reload,
  ROOT_ID,
  rootText,
  sent,
} from "./utils.js";

/** A document with a paragraph per text, committed and ready to edit. */
function paragraphs(texts: string[]) {
  const doc = new Doc({ ...config(), id: ROOT_ID });
  doc.forceCommit();
  const nodes = texts.map((text) => {
    const node = doc.createNode(Paragraph);
    doc.root.append(node);
    node.state.t.insert(0, text);
    return node;
  });
  doc.forceCommit();
  return { doc, nodes };
}

const assertWellFormed = (text: string) =>
  expect(text.isWellFormed(), JSON.stringify(text)).toBe(true);

describe("set and applySpans", () => {
  test("set only touches what changed", () => {
    const { nodes } = paragraphs(["Hello world"]);
    const text = nodes[0]!.state.t;
    text.set("Hello there");
    expect(text.get()).toBe("Hello there");
    text.set("Hello");
    expect(text.get()).toBe("Hello");
    text.set("Hello!");
    expect(text.get()).toBe("Hello!");
    text.set("Hello!");
    expect(text.get()).toBe("Hello!");
  });

  test("set never splits a surrogate pair that shares a half with the new text", () => {
    const { nodes } = paragraphs(["a😀"]);
    const text = nodes[0]!.state.t;
    // Same high surrogate, different low one.
    text.set("a😁");
    expect(text.get()).toBe("a😁");
    // Same low surrogate, different high one.
    text.set("a𐘁");
    expect(text.get()).toBe("a𐘁");
    assertWellFormed(text.get());
  });

  test("applySpans keeps a surrogate pair whole even if the target splits it", () => {
    const { nodes } = paragraphs(["\uDE00"]);
    const text = nodes[0]!.state.t;
    text.applySpans([{ text: "\uD83D", attrs: {} }]);
    expect(text.get()).toBe("😀");
    assertWellFormed(text.get());
  });

  test("applySpans formats with as few ranges as it can", () => {
    const { nodes } = paragraphs(["abcdefgh"]);
    const text = nodes[0]!.state.t;
    const target = [
      { text: "ab", attrs: { bold: true } },
      { text: "cd", attrs: { bold: true, italic: true } },
      { text: "ef", attrs: { link: "https://a" } },
      { text: "gh", attrs: { link: "https://b" } },
    ];
    text.applySpans(target);
    expect(text.spans()).toStrictEqual(target);
    const lessItalic = [
      { text: "abcd", attrs: { bold: true } },
      ...target.slice(2),
    ];
    text.applySpans(lessItalic);
    expect(text.spans()).toStrictEqual(lessItalic);
    text.applySpans([{ text: "abcdefgh", attrs: {} }]);
    expect(text.spans()).toStrictEqual([{ text: "abcdefgh", attrs: {} }]);
  });

  test("applySpans inserts letters with the state of their span", () => {
    const { nodes } = paragraphs(["ad"]);
    const target = [
      { text: "a", attrs: {} },
      { text: "bc", attrs: { bold: true } },
      { text: "d", attrs: {} },
    ];
    nodes[0]!.state.t.applySpans(target);
    expect(nodes[0]!.state.t.spans()).toStrictEqual(target);
  });
});

describe("copy", () => {
  test("a copied paragraph has its own copy of the formatted text", () => {
    const { nodes } = paragraphs(["Hello world"]);
    const original = nodes[0]!;
    original.state.t.format(0, 5, "bold", true);
    original.copy(original, "after");
    const copy = original.next;
    if (!copy?.is(Paragraph)) throw new Error("no copy");
    expect(copy.state.t.spans()).toStrictEqual(original.state.t.spans());
    copy.state.t.insert(0, "Copy: ");
    expect(original.state.t.get()).toBe("Hello world");
    expect(copy.state.t.get()).toBe("Copy: Hello world");
  });
});

describe("applySpans with repeated text", () => {
  const plain = (text: string) => [{ text, attrs: {} }];

  test("the caret picks which copy is the new one", () => {
    for (const [caret, original] of [
      [8, 8],
      [undefined, 0],
    ] as const) {
      const { nodes } = paragraphs(["cat dog"]);
      const t = nodes[0]!.state.t;
      const first = t.letterAt(0)!;
      t.applySpans(plain("cat dog cat dog"), caret);
      expect(t.get()).toBe("cat dog cat dog");
      expect(t.indexOfLetter(first)).toBe(original);
    }
  });

  test("a caret outside the possible places is clamped", () => {
    const { nodes } = paragraphs(["aaaa"]);
    const t = nodes[0]!.state.t;
    t.applySpans(plain("aaaaa"), 99);
    t.applySpans(plain("aaa"), -5);
    expect(t.get()).toBe("aaa");
  });

  test("a caret that would split a surrogate pair is ignored", () => {
    const { nodes } = paragraphs(["😀😀"]);
    const t = nodes[0]!.state.t;
    t.applySpans(plain("😀😀😀"), 3);
    t.applySpans(plain("😀😀"), 1);
    expect(t.get()).toBe("😀😀");
  });
});

test("a text of thousands of runs finds every letter", () => {
  const letters = "abcdefghij".repeat(400);
  const { nodes } = paragraphs([letters]);
  const t = nodes[0]!.state.t;
  // Every other letter bold: a run per letter.
  for (let index = 0; index < letters.length; index += 2)
    t.format(index, index + 1, "bold", true);
  expect(t.get()).toBe(letters);
  expect(t.spans()).toHaveLength(letters.length);
  for (const index of [0, 1, 777, 2048, letters.length - 1])
    expect(t.indexOfLetter(t.letterAt(index)!)).toBe(index);
});

describe("edges", () => {
  test("a document that reuses its session after a reload types after its stored letters", () => {
    const { doc } = paragraphs(["a"]);
    const sameSession = { ...config("alice"), id: doc.root.id };
    const first = Doc.fromJSON(sameSession, doc.toJSON());
    const text = (target: Doc) => {
      const node = target.root.first;
      if (!node?.is(Paragraph)) throw new Error("no paragraph");
      return node.state.t;
    };
    text(first).insert(1, "b");
    first.forceCommit();
    const second = Doc.fromJSON(
      { ...config("alice"), id: doc.root.id },
      first.toJSON(),
    );
    text(second).insert(2, "c");
    expect(text(second).get()).toBe("abc");
  });

  test("a root text value that is not a text store cannot be stored", () => {
    const { doc } = paragraphs(["ab"]);
    Object.assign(doc.root["_state"], { "~t": "corrupt" });
    expect(() => doc.toJSON()).toThrowError("Expected a text store");
  });

  test("a document without undo imports no steps", () => {
    const { doc, nodes } = paragraphs(["ab"]);
    nodes[0]!.state.t.insert(2, "c");
    doc.forceCommit();
    const history = doc.undoManager.exportHistory();
    const { undoManager, ...withoutUndo } = config();
    expect(undoManager.maxUndoSteps).toBeGreaterThan(0);
    const copy = Doc.fromJSON(
      { ...withoutUndo, id: doc.root.id },
      doc.toJSON(),
    );
    copy.forceCommit();
    copy.undoManager.importHistory(history);
    expect(copy.undoManager.canUndo()).toBe(false);
  });
});

describe("hand-written text rows", () => {
  test("a first state as flags, and parts that are neither, are read", () => {
    const { doc, text } = flat("");
    receive(doc, ["x.-", [["ab", "b", 5, { i: 2 }], "^"]]);
    expect(text.spans()).toStrictEqual([{ text: "ab", attrs: { b: 1, i: 2 } }]);
  });

  test("a first state with nothing in it is none", () => {
    const { doc, text } = flat("");
    receive(doc, ["x.-", [["ab", 5], "^"]]);
    expect(text.spans()).toStrictEqual([{ text: "ab", attrs: {} }]);
  });

  test("a key that reads as a number travels as one", () => {
    const { doc, text } = flat("ab", "x");
    const copy = reload(doc);
    receive(copy, ...sent(doc, () => text.format(0, 1, "0", true)));
    expect(rootText(copy).spans()).toStrictEqual(text.spans());
  });

  test("an insert without letters changes nothing", () => {
    const { doc, text } = flat("ab");
    receive(doc, ["x.0", [[]]]);
    expect(text.get()).toBe("ab");
  });
});
