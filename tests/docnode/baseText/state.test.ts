import { Doc } from "@docukit/docnode";
import { describe, expect, test } from "vitest";
import { checkUndoManager } from "../utils.js";

import {
  defaultConfig,
  flat,
  Network,
  receive,
  reload,
  rootText,
  runsOf,
  sent,
  styled,
} from "./utils.js";

describe("setLetterState: the last one applied wins", () => {
  test("bold, italic and their undos", () => {
    const doc = new Doc(defaultConfig());
    doc.forceCommit();
    const text = rootText(doc);
    checkUndoManager(4, doc, () => {
      text.insert(0, "Hello world");
      doc.forceCommit();
      text.format(0, 5, "bold", true);
      doc.forceCommit();
      text.format(3, 8, "bold", "x");
      doc.forceCommit();
      text.format(0, 11, "bold", null);
      doc.forceCommit();
    });
  });

  test("a format that changes nothing sends nothing", () => {
    const { doc, text } = flat("abc");
    expect(sent(doc, () => text.format(0, 3, "bold", null))).toStrictEqual([]);
    expect(sent(doc, () => text.format(2, 1, "bold", true))).toStrictEqual([]);
  });

  test("bold of 50 letters is one range and one value", () => {
    const { doc, text } = flat("x".repeat(100));
    const [batch] = sent(doc, () => text.format(10, 60, "0", 1));
    expect(batch).toStrictEqual(["a.0Z", -5, 0, [90, 50], 1]);
  });

  test("a range is all that is between its first and last letter: what a peer typed in it too", () => {
    const network = new Network("Revenue grew 4% in Q3.", ["a", "b"]);
    network.edit("a", (text) => text.insert(13, "by "));
    network.edit("b", (text) => text.format(8, 15, "link", "x"));
    network.exchange();
    expect(styled(network.converged())).toStrictEqual([
      "Revenue ",
      'grew by 4%:{"link":"x"}',
      " in Q3.",
    ]);
    // Its undo too.
    network.undo("b");
    network.exchange();
    expect(styled(network.converged())).toStrictEqual([
      "Revenue grew by 4% in Q3.",
    ]);
  });

  test("of a range whose ends a peer deleted, what is between those left", () => {
    const network = new Network("abcdef", ["a", "b"]);
    network.edit("a", (text) => text.delete(1, 1));
    network.edit("a", (text) => text.delete(3, 1));
    network.edit("b", (text) => text.format(1, 5, "bold", true));
    network.exchange();
    expect(styled(network.converged())).toStrictEqual([
      "a",
      'cd:{"bold":true}',
      "f",
    ]);
    network.edit("a", (text) => text.delete(1, 2));
    network.exchange();
    network.redo("b");
    network.undo("b");
    network.exchange();
    expect(styled(network.converged())).toStrictEqual(["af"]);
  });

  test("runs a format cut are joined when it is undone", () => {
    const { doc, text } = flat("abcdef");
    text.format(1, 3, "bold", true);
    doc.forceCommit();
    text.format(2, 5, "italic", true);
    doc.forceCommit();
    doc.undoManager.undo();
    doc.undoManager.undo();
    doc.forceCommit();
    expect(runsOf(doc)).toStrictEqual([["abcdef"]]);
    const peer = reload(doc);
    receive(peer, ...sent(doc, () => text.format(0, 6, "bold", 1)));
    expect(rootText(peer).spans()).toStrictEqual([
      { text: "abcdef", attrs: { bold: 1 } },
    ]);
    expect(runsOf(peer)).toStrictEqual([["abcdef"]]);
  });
});
