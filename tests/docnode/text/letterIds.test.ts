import { describe, expect, test } from "vitest";

import { orderedCluster, paragraphs } from "./utils.js";

/**
 * `letterAt` names a letter, `indexOfLetter` finds it again: a place in the
 * text that stays with its letters, like a cursor of another user.
 */

/** The text with `|` where `index` is. */
const caret = (text: string, index: number | undefined) =>
  index === undefined
    ? undefined
    : `${text.slice(0, index)}|${text.slice(index)}`;

describe("letter ids", () => {
  test("a letter is found again after edits before and after it", () => {
    const { nodes } = paragraphs(["hello world"], true, "a");
    const t = nodes[0]!.state.t;
    const letter = t.letterAt(6)!;
    t.insert(0, ">> ");
    t.insert(t.length, "!");
    t.delete(3, 2);
    expect(caret(t.get(), t.indexOfLetter(letter))).toBe(">> llo |world!");
  });

  test("a deleted letter is where it was, and back after an undo", () => {
    const { doc, nodes } = paragraphs(["hello world"], true, "a");
    const t = nodes[0]!.state.t;
    const letter = t.letterAt(6)!;
    t.delete(4, 4);
    doc.forceCommit();
    expect(caret(t.get(), t.indexOfLetter(letter))).toBe("hell|rld");
    doc.undoManager.undo();
    expect(caret(t.get(), t.indexOfLetter(letter))).toBe("hello |world");
  });

  test("a letter keeps its place under a concurrent insert next to it", () => {
    const cluster = orderedCluster(["ab"], 2);
    const [id] = cluster.paragraphIds(0);
    const t = (replica: number) => cluster.node(replica, id!).state.t;
    const letter = t(0).letterAt(1)!;
    cluster.edit(1, () => t(1).insert(1, "X"));
    cluster.deliverAll();
    expect(caret(t(0).get(), t(0).indexOfLetter(letter))).toBe("aX|b");
  });

  test("there is no letter outside the text", () => {
    const { nodes } = paragraphs(["ab"]);
    const t = nodes[0]!.state.t;
    expect([t.letterAt(-1), t.letterAt(2)]).toStrictEqual([
      undefined,
      undefined,
    ]);
  });

  test("ids of no letter of this text are not found", () => {
    const { nodes } = paragraphs(["ab", "cd"], false, "a");
    const [first, second] = nodes.map((node) => node.state.t);
    const letter = first!.letterAt(0)!;
    const session = letter.slice(0, letter.lastIndexOf(":"));
    const ids = [
      "",
      "a",
      `${session}:`,
      `${session}:-1`,
      `${session}:1.5`,
      `${session}:999`,
      `unknown:0`,
    ];
    expect(ids.map((id) => first!.indexOfLetter(id))).toStrictEqual(
      ids.map(() => undefined),
    );
    expect(second!.indexOfLetter(letter)).toBeUndefined();
  });
});
