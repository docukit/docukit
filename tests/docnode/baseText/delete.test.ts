import {
  _INTERNAL_decodeOperations as decode,
  Doc,
  type Operations,
} from "@docukit/docnode";
import { describe, expect, test } from "vitest";
import { checkUndoManager } from "../utils.js";

import {
  config,
  defaultConfig,
  flat,
  Network,
  Paragraph,
  receive,
  reload,
  rootText,
  ROOT_ID,
  runsOf,
  sent,
  sessionIds,
  stored,
  styled,
} from "./utils.js";

describe("a delete removes letters for good", () => {
  test("the stored text keeps only their ids and where they were", () => {
    const { doc, text } = flat("0123456789".repeat(20));
    for (let count = 0; count < 200; count++) {
      text.delete(count % 2 ? 0 : text.length - 1, 1);
      doc.forceCommit();
    }
    expect(text.get()).toBe("");
    // One ghost: the 200 ids, at the start of the text, with the text's
    // envelope (sessions, an empty text, its columns).
    expect(stored(doc).length - stored(flat().doc).length).toBeLessThan(60);
    const copy = reload(doc);
    expect(stored(copy)).toBe(stored(doc));
  });

  test("letters deleted one by one leave what deleting them at once does", () => {
    const once = flat("abcdef");
    once.text.delete(1, 4);
    once.doc.forceCommit();
    const backspaces = flat("abcdef");
    for (const index of [4, 3, 2, 1]) {
      backspaces.text.delete(index, 1);
      backspaces.doc.forceCommit();
    }
    const deletes = flat("abcdef");
    for (let count = 0; count < 4; count++) {
      deletes.text.delete(1, 1);
      deletes.doc.forceCommit();
    }
    expect(stored(backspaces.doc)).toBe(stored(once.doc));
    expect(stored(deletes.doc)).toBe(stored(once.doc));
  });

  test("letters a peer deleted first are deleted once", () => {
    const network = new Network("abcd", ["a", "b"]);
    network.edit("a", (text) => text.delete(1, 2));
    network.edit("b", (text) => text.delete(0, 3));
    network.exchange();
    expect(network.converged()).toStrictEqual([{ text: "d", attrs: {} }]);
  });
});

describe("undo", () => {
  test("typing, deleting, formatting and their undos and redos", () => {
    const doc = new Doc(defaultConfig());
    const node = doc.createNode(Paragraph);
    checkUndoManager(5, doc, () => {
      doc.root.append(node);
      node.state.t.insert(0, "Hello brave world");
      doc.forceCommit();
      node.state.t.delete(5, 6);
      doc.forceCommit();
      node.state.t.format(0, 5, "bold", true);
      doc.forceCommit();
      node.state.t.delete(0, 2);
      doc.forceCommit();
      node.state.t.insert(3, "y", { italic: true, bold: null });
      doc.forceCommit();
    });
  });

  test("an undo of a delete brings the same letters back, with their state", () => {
    const doc = new Doc(defaultConfig());
    doc.forceCommit();
    const text = rootText(doc);
    checkUndoManager(3, doc, () => {
      text.insert(0, "Hello world");
      doc.forceCommit();
      text.format(0, 5, "link", "x");
      doc.forceCommit();
      text.delete(2, 6);
      doc.forceCommit();
    });
    doc.undoManager.undo();
    doc.forceCommit();
    expect(styled(text.spans())).toStrictEqual([
      'Hello:{"link":"x"}',
      " world",
    ]);
    // Their ids: the runs are whole again.
    expect(runsOf(doc)).toStrictEqual([["Hello", " world"]]);
    // Undoing the insert takes all of them, also those the undo brought back.
    doc.undoManager.undo();
    doc.undoManager.undo();
    doc.forceCommit();
    expect(text.get()).toBe("");
  });

  test("an undo of a delete goes before the letter that was after it", () => {
    const network = new Network("abcd", ["a", "b"]);
    network.edit("a", (text) => text.delete(1, 2));
    network.exchange();
    network.edit("b", (text) => text.insert(1, "Z"));
    network.exchange();
    network.undo("a");
    network.exchange();
    expect(network.converged()).toStrictEqual([{ text: "aZbcd", attrs: {} }]);
  });

  test("after the letter before it when that one is gone, else where it was", () => {
    const network = new Network("abcd", ["a", "b"]);
    network.edit("a", (text) => text.delete(1, 2));
    network.exchange();
    network.edit("b", (text) => text.delete(1, 1));
    network.exchange();
    network.undo("a");
    network.exchange();
    expect(network.converged()).toStrictEqual([{ text: "abc", attrs: {} }]);
    network.redo("a");
    network.edit("b", (text) => text.delete(0, 1));
    network.exchange();
    expect(network.converged()).toStrictEqual([]);
    network.undo("a");
    network.exchange();
    expect(network.converged()).toStrictEqual([{ text: "bc", attrs: {} }]);
  });

  test("of letters it never had: they are put back where they were", () => {
    const { doc, text } = flat("ab");
    const peer = reload(doc);
    sent(doc, () => text.insert(1, "x"));
    sent(doc, () => text.delete(1, 1));
    const [undo] = sent(doc, () => doc.undoManager.undo());
    receive(peer, undo!);
    expect(rootText(peer).get()).toBe("axb");
  });

  test("of letters in a node not here: nothing", () => {
    const doc = new Doc({
      ...config(),
      id: ROOT_ID,
      nodeIdGenerator: sessionIds("nodeid", "-"),
    });
    const node = doc.createNode(Paragraph);
    doc.root.append(node);
    doc.forceCommit();
    const batches = [
      ...sent(doc, () => node.state.t.insert(0, "x")),
      ...sent(doc, () => node.state.t.delete(0, 1)),
      ...sent(doc, () => doc.undoManager.undo()),
    ];
    expect(node.state.t.get()).toBe("x");
    const other = flat("ab").doc;
    receive(other, ...batches);
    expect(rootText(other).get()).toBe("ab");
  });

  test("of a delete that took the start of the text", () => {
    const { doc, text } = flat("abc");
    text.delete(0, 2);
    doc.forceCommit();
    text.delete(0, 1);
    doc.forceCommit();
    doc.undoManager.undo();
    doc.undoManager.undo();
    doc.forceCommit();
    expect(text.get()).toBe("abc");
  });

  test("two peers delete the same letters: their undos bring back one copy", () => {
    const network = new Network("abcd", ["a", "b"]);
    network.edit("a", (text) => text.delete(1, 2));
    network.edit("b", (text) => text.delete(1, 2));
    network.exchange();
    network.undo("a");
    network.undo("b");
    network.exchange();
    expect(network.converged()).toStrictEqual([{ text: "abcd", attrs: {} }]);
  });

  test("letters a peer brought back stay; the others follow them", () => {
    const network = new Network("abcd", ["a", "b"]);
    network.edit("a", (text) => text.delete(1, 1));
    network.edit("b", (text) => text.delete(1, 2));
    network.exchange();
    network.undo("a");
    network.exchange();
    network.undo("b");
    network.exchange();
    expect(network.converged()).toStrictEqual([{ text: "abcd", attrs: {} }]);
  });

  test("an undo applied again changes nothing", () => {
    const { doc, text } = flat("abcd");
    text.delete(1, 2);
    doc.forceCommit();
    const undo = sent(doc, () => doc.undoManager.undo());
    const peer = reload(flat("abcd").doc);
    receive(peer, ...sent(doc, () => undefined));
    expect(rootText(peer).get()).toBe("abcd");
    receive(doc, ...undo);
    expect(text.get()).toBe("abcd");
  });

  test("the undo of a delete names the letters around it, their ids and state", () => {
    const { doc, text } = flat("abcd");
    text.format(1, 2, "bold", true);
    doc.forceCommit();
    const [batch] = sent(doc, () => text.delete(1, 2));
    const [undo] = sent(doc, () => doc.undoManager.undo());
    // The letters around them are the ids right before and after: left out.
    expect(decode(undo!)[0]).toStrictEqual([
      [3, 4, "a", 4, "bc", [2, 2], [1, { bold: true }, 1, 0]],
    ]);
    // A delete, and its undo, cost about the same as the letters.
    const size = (batch: Operations) => JSON.stringify(batch).length;
    expect(size(batch!)).toBeLessThan(20);
    expect(size(undo!)).toBeLessThan(50);
  });
});
