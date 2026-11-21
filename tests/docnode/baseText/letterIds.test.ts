import { describe, expect, test } from "vitest";

import { flat, Network, Paragraph } from "./utils.js";

/** The text with `|` where `index` is. */
const caret = (text: string, index: number | undefined) =>
  index === undefined
    ? undefined
    : `${text.slice(0, index)}|${text.slice(index)}`;

describe("letter ids in Base: a deleted letter is where its ghost is", () => {
  test("found again after edits before and after it", () => {
    const { text } = flat("hello world");
    const letter = text.letterAt(6)!;
    text.insert(0, ">> ");
    text.insert(text.length, "!");
    text.delete(3, 2);
    expect(caret(text.get(), text.indexOfLetter(letter))).toBe(
      ">> llo |world!",
    );
  });

  test("deleted by a peer: right after the letter before it", () => {
    const network = new Network("hello world", ["a", "b"]);
    const letter = network.text("a").letterAt(6)!;
    const first = network.text("a").letterAt(0)!;
    network.edit("b", (text) => text.delete(4, 4));
    network.edit("b", (text) => text.delete(0, 2));
    network.exchange();
    const text = network.text("a");
    expect(caret(text.get(), text.indexOfLetter(letter))).toBe("ll|rld");
    expect(caret(text.get(), text.indexOfLetter(first))).toBe("|llrld");
  });

  test("no letter outside the text, nor in a text without letters", () => {
    const { doc, text } = flat("ab");
    const empty = doc.createNode(Paragraph);
    doc.root.append(empty);
    expect([text.letterAt(-1), text.letterAt(2)]).toStrictEqual([
      undefined,
      undefined,
    ]);
    expect(empty.state.t.letterAt(0)).toBeUndefined();
    expect(empty.state.t.indexOfLetter(text.letterAt(0)!)).toBeUndefined();
    expect(text.indexOfLetter("nope")).toBeUndefined();
    expect(text.indexOfLetter("x:0")).toBeUndefined();
  });
});
