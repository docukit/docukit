import { Doc } from "@docukit/docnode";
import { describe, expect, test } from "vitest";

import { config, flat, Paragraph, receive, ROOT_ID, runsOf } from "./utils.js";

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

describe("set", () => {
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

  test("set keeps a surrogate pair whole even if the target splits it", () => {
    const { nodes } = paragraphs(["\uDE00"]);
    const text = nodes[0]!.state.t;
    text.set("\uD83D");
    expect(text.get()).toBe("😀");
    assertWellFormed(text.get());
  });
});

describe("copy", () => {
  test("a copied paragraph has its own copy of the text", () => {
    const { nodes } = paragraphs(["Hello world"]);
    const original = nodes[0]!;
    original.copy(original, "after");
    const copy = original.next;
    if (!copy?.is(Paragraph)) throw new Error("no copy");
    expect(copy.state.t.get()).toBe("Hello world");
    copy.state.t.insert(0, "Copy: ");
    expect(original.state.t.get()).toBe("Hello world");
    expect(copy.state.t.get()).toBe("Copy: Hello world");
  });
});

describe("set with repeated text", () => {
  test("the caret picks which copy is the new one", () => {
    for (const [caret, original] of [
      [8, 8],
      [undefined, 0],
    ] as const) {
      const { nodes } = paragraphs(["cat dog"]);
      const t = nodes[0]!.state.t;
      const first = t.letterAt(0)!;
      t.set("cat dog cat dog", caret);
      expect(t.get()).toBe("cat dog cat dog");
      expect(t.indexOfLetter(first)).toBe(original);
    }
  });

  test("a caret outside the possible places is clamped", () => {
    const { nodes } = paragraphs(["aaaa"]);
    const t = nodes[0]!.state.t;
    t.set("aaaaa", 99);
    t.set("aaa", -5);
    expect(t.get()).toBe("aaa");
  });

  test("a caret that would split a surrogate pair is ignored", () => {
    const { nodes } = paragraphs(["😀😀"]);
    const t = nodes[0]!.state.t;
    t.set("😀😀😀", 3);
    t.set("😀😀", 1);
    expect(t.get()).toBe("😀😀");
  });
});

test("a text of thousands of runs finds every letter", () => {
  const letters = "abcdefghij".repeat(400);
  const { doc, nodes } = paragraphs(["xy"]);
  const t = nodes[0]!.state.t;
  // Each letter right after "x", before the one typed before it: a run each.
  for (const letter of letters) t.insert(1, letter);
  expect(t.get()).toBe(`x${[...letters].reverse().join("")}y`);
  expect(runsOf(doc)[0]).toHaveLength(letters.length + 2);
  for (const index of [0, 1, 777, 2048, letters.length + 1])
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
  test("an insert without letters changes nothing", () => {
    const { doc, text } = flat("ab");
    // @ts-expect-error - an insert whose letters are not a string
    receive(doc, ["x.0", [[]]]);
    expect(text.get()).toBe("ab");
  });
});
