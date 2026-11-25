import { _INTERNAL_decodeOperations as decode, Doc } from "@docukit/docnode";
import { describe, expect, test } from "vitest";
import { checkUndoManager } from "../utils.js";

import {
  config,
  defaultConfig,
  flat,
  Network,
  P,
  Paragraph,
  race,
  receive,
  reload,
  rootText,
  ROOT_ID,
  runsOf,
  sent,
  styled,
  type Text,
} from "./utils.js";

const bold = (text: Text) => text.format(0, 5, "bold", true);

describe("what a letter inherits is copied into it when it is inserted", () => {
  test("a letter typed after a bold one is bold and sends no state", () => {
    const { doc, text } = flat("Hello world");
    bold(text);
    doc.forceCommit();
    const [typed] = sent(doc, () => text.insert(5, "!"));
    // The letter typed before "o" is the id before " ": the sign says so.
    expect(typed).toStrictEqual(["a.A", "!", -6]);
    expect(styled(text.spans())).toStrictEqual([
      'Hello!:{"bold":true}',
      " world",
    ]);
    // It is the letter's own: the letter it was typed after can change.
    text.format(4, 5, "bold", null);
    doc.forceCommit();
    expect(styled(rootText(reload(doc)).spans())).toStrictEqual([
      'Hell:{"bold":true}',
      "o",
      '!:{"bold":true}',
      " world",
    ]);
  });

  test("a bold covers what others typed right after it, in either order", () => {
    const edits = { a: bold, b: (text: Text) => text.insert(5, "!") };
    for (const order of [
      ["a", "b"],
      ["b", "a"],
    ])
      expect(styled(race("Hello world", edits, order))).toStrictEqual([
        'Hello!:{"bold":true}',
        " world",
      ]);
  });

  test("so does an unbold: a letter typed after the one it unbolds stays plain", () => {
    const edits = {
      a: (text: Text) => {
        text.format(0, 2, "bold", true);
        text.format(0, 1, "bold", null);
      },
      b: (text: Text) => text.insert(1, "B"),
    };
    for (const order of [
      ["a", "b"],
      ["b", "a"],
    ])
      expect(styled(race("AC", edits, order))).toStrictEqual([
        "AB",
        'C:{"bold":true}',
      ]);
  });

  test("up to the letter that was after it, and not past a paragraph letter", () => {
    const edits = {
      a: bold,
      b: (text: Text) => {
        text.insert(6, "!");
        text.insert(5, `?${P}`);
      },
    };
    for (const order of [
      ["a", "b"],
      ["b", "a"],
    ])
      expect(styled(race("Hello world", edits, order))).toStrictEqual([
        'Hello?:{"bold":true}',
        `${P} !world`,
      ]);
  });

  test("to the end of the text when it was its end", () => {
    const edits = {
      a: (text: Text) => text.format(6, 11, "italic", true),
      b: (text: Text) => text.insert(11, "s"),
    };
    for (const order of [
      ["a", "b"],
      ["b", "a"],
    ])
      expect(styled(race("Hello world", edits, order))).toStrictEqual([
        "Hello ",
        'worlds:{"italic":true}',
      ]);
  });

  test("not on a letter typed there with a value of its own", () => {
    const network = new Network("Hello world", ["a", "b"]);
    network.edit("a", bold);
    network.exchange();
    network.edit("a", (text) => text.format(0, 5, "bold", null));
    network.edit("b", (text) => text.insert(5, "!", { bold: "x" }));
    network.exchange();
    expect(styled(network.converged())).toStrictEqual([
      "Hello",
      '!:{"bold":"x"}',
      " world",
    ]);
  });

  test("a letter typed next to deleted ones inherits from them, as if they were there", () => {
    const network = new Network("Hello world", ["a", "b"]);
    network.edit("a", bold);
    network.exchange();
    network.edit("a", (text) => text.delete(0, 5));
    network.edit("b", (text) => {
      text.insert(5, "!");
      text.insert(3, "?");
    });
    network.exchange();
    expect(styled(network.converged())).toStrictEqual([
      '?!:{"bold":true}',
      " world",
    ]);
  });

  test("a link from deleted letters on both sides", () => {
    const network = new Network("see here now", ["a", "b"]);
    network.edit("a", (text) => text.format(4, 8, "link", "u"));
    network.exchange();
    network.edit("a", (text) => text.delete(4, 4));
    network.edit("b", (text) => text.insert(6, "-"));
    network.exchange();
    expect(styled(network.converged())).toStrictEqual([
      "see ",
      '-:{"link":"u"}',
      " now",
    ]);
  });

  test("a link only from inside: both letters around must have it", () => {
    const { doc, text } = flat("see here now");
    text.format(4, 8, "link", "u");
    doc.forceCommit();
    text.insert(6, "-");
    text.insert(9, "!");
    doc.forceCommit();
    expect(styled(text.spans())).toStrictEqual([
      "see ",
      'he-re:{"link":"u"}',
      "! now",
    ]);
  });

  test("a paragraph letter inherits nothing, nor what is typed after it in one insert", () => {
    const { doc, text } = flat("ab");
    text.format(0, 2, "bold", true);
    doc.forceCommit();
    text.insert(2, `c${P}d`);
    doc.forceCommit();
    expect(styled(text.spans())).toStrictEqual(['abc:{"bold":true}', `${P}d`]);
    // With a state given, the letters after it say all of it.
    const [batch] = sent(doc, () => text.insert(1, `x${P}y`, { bold: true }));
    expect(decode(batch!)[0]).toStrictEqual([
      [3, "a", 5, [`x${P}y`, { bold: true }], -2],
    ]);
  });

  test("a state given leaves out what the letter inherits, and says what it does not take", () => {
    const { doc, text } = flat("ab");
    text.format(0, 2, "bold", true);
    doc.forceCommit();
    const [same] = sent(doc, () => text.insert(2, "c", { bold: true }));
    const [plain] = sent(doc, () => text.insert(3, "d", {}));
    const [more] = sent(doc, () =>
      text.insert(2, "e", { bold: true, italic: true }),
    );
    expect(decode(same!)[0]).toStrictEqual([[3, "a", 2, "c"]]);
    expect(decode(plain!)[0]).toStrictEqual([
      [3, "a", 3, ["d", { bold: null }]],
    ]);
    expect(decode(more!)[0]).toStrictEqual([
      [3, "a", 4, ["e", { italic: true }], -3],
    ]);
    expect(styled(text.spans())).toStrictEqual([
      'ab:{"bold":true}',
      'e:{"bold":true,"italic":true}',
      'c:{"bold":true}',
      "d",
    ]);
  });

  test("a node not in the document inherits nothing", () => {
    const doc = new Doc({ ...config(), id: ROOT_ID });
    doc.forceCommit();
    const node = doc.createNode(Paragraph);
    node.state.t.insert(0, "ab", { bold: true });
    node.state.t.insert(2, "c");
    doc.root.append(node);
    node.state.t.insert(2, "d");
    doc.forceCommit();
    expect(styled(node.state.t.spans())).toStrictEqual([
      'abd:{"bold":true}',
      "c",
    ]);
  });
});

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

  test.each(["bold", "link"])(
    "its undo gives a letter between two it changed its own %s back",
    (key) => {
      const doc = new Doc(defaultConfig());
      doc.forceCommit();
      const text = rootText(doc);
      checkUndoManager(3, doc, () => {
        text.insert(0, "ab");
        doc.forceCommit();
        // `X` is not between `a` and `b` in ids: `b` is `a`'s next id.
        text.insert(1, "X", { [key]: true });
        doc.forceCommit();
        text.format(0, 3, key, 3);
        doc.forceCommit();
      });
    },
  );

  test("its undo gives a peer's letter between two it changed its own value back", () => {
    const network = new Network("ab", ["mine", "peer"]);
    network.edit("peer", (text) => text.insert(1, "X", { bold: true }));
    network.exchange();
    network.edit("mine", (text) => text.format(0, 3, "bold", 3));
    network.exchange();
    network.undo("mine");
    network.exchange();
    expect(styled(network.converged())).toStrictEqual([
      "a",
      'X:{"bold":true}',
      "b",
    ]);
  });

  test("a format that changes nothing sends nothing", () => {
    const { doc, text } = flat("abc");
    expect(sent(doc, () => text.format(0, 3, "bold", null))).toStrictEqual([]);
    expect(sent(doc, () => text.format(2, 1, "bold", true))).toStrictEqual([]);
  });

  test("bold of 50 letters is one range and one value", () => {
    const { doc, text } = flat("x".repeat(100));
    const [batch] = sent(doc, () => text.format(10, 60, "0", 1));
    expect(batch).toStrictEqual(["a.0Z", 5, 0, [90, 50], 1]);
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
