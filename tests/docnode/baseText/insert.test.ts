import {
  _INTERNAL_decodeOperations as decode,
  Doc,
  mergeOperations,
  type Operations,
} from "@docukit/docnode";
import { describe, expect, test } from "vitest";

import {
  config,
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
  sessionIds,
  stored,
  type Text,
} from "./utils.js";

/** The text operations of a batch, with whole ids. */
const opsOf = (batch: Operations) => decode(batch)[0];

/** Where the first insert of a batch says its letters go. */
const startOf = (batch: Operations) => {
  const right = opsOf(batch)[0]![4];
  return typeof right === "string" ? right : "";
};

describe("an insert names what the receiver needs to find its place", () => {
  test("typing at the end sends only the letters", () => {
    const { doc, text } = flat("ab");
    const [batch] = sent(doc, () => text.insert(2, "c"));
    // The head names the session and the counter, in base 64 ("1" is 2).
    expect(batch).toStrictEqual(["a.1", "c"]);
  });

  test("typing after the letter typed before also names the right one", () => {
    const { doc, text } = flat("ac");
    sent(doc, () => text.insert(1, "x"));
    // A batch of its own: the server may order a delete of "x" before it.
    expect(opsOf(sent(doc, () => text.insert(2, "y"))[0]!)).toStrictEqual([
      [3, "a", 3, "y", 2],
    ]);
  });

  test("inside a run, the right one says the left one is the id before it", () => {
    const { doc, text } = flat("ac");
    const [batch] = sent(doc, () => text.insert(1, "b"));
    // `-2` on the wire is `"<"`: the right one is the letter just before.
    expect(batch).toStrictEqual(["a.1", "b", "<"]);
    expect(opsOf(batch!)).toStrictEqual([[3, "a", 2, "b", -2]]);
    // Of another session, the left one is `0`: the id before the right one.
    const peer = reload(flat("ac").doc, "b");
    const [other] = sent(peer, () => rootText(peer).insert(1, "x"));
    expect(opsOf(other!)).toStrictEqual([[3, "b", 0, "x", "a.0", 0]]);
  });

  test("elsewhere it names both, and the start of the root's text is `^`", () => {
    const { doc, text } = flat("abc");
    sent(doc, () => text.delete(1, 1));
    const [between] = sent(doc, () => text.insert(1, "x"));
    expect(opsOf(between!)).toStrictEqual([[3, "a", 3, "x", 3, 1]]);
    const [start] = sent(doc, () => text.insert(0, "y"));
    expect(opsOf(start!)).toStrictEqual([[3, "a", 4, "y", "^"]]);
  });

  test("a letter inserted before in the same batch needs no other", () => {
    const { doc, text } = flat("ab");
    const [batch] = sent(doc, () => {
      text.insert(1, "x");
      // Right before "x": no left one (`-1`).
      text.insert(1, "w");
      // Right after "x", which is not the id before it: no right one (`0`).
      text.insert(3, "y");
    });
    expect(opsOf(batch!)).toStrictEqual([
      [3, "a", 2, "x", -2],
      [3, "a", 3, "w", 3, -1],
      [3, "a", 4, "y", 0, 3],
    ]);
    const peer = reload(flat("ab").doc);
    receive(peer, batch!);
    expect(rootText(peer).get()).toBe("awxyb");
  });
});

describe("where a remote insert goes", () => {
  const typeAfterB = { b: (text: Text) => text.insert(2, "x") };

  test("right after its left letter", () => {
    const text = race("abc", typeAfterB, ["b"]);
    expect(text).toBe("abxc");
  });

  test("right before its right letter when the left one is gone", () => {
    const edits = { ...typeAfterB, a: (text: Text) => text.delete(1, 1) };
    expect(race("abc", edits, ["a", "b"])).toBe("axc");
  });

  test("where they were when both are gone: after the letter before them", () => {
    const edits = { ...typeAfterB, a: (text: Text) => text.delete(1, 2) };
    expect(race("abcd", edits, ["a", "b"])).toBe("axd");
    // In the other order, the delete only takes the letters it saw.
    expect(race("abcd", edits, ["b", "a"])).toBe("axd");
  });

  test("letters of a batch go after the first one, where the others were", () => {
    const network = new Network("abcd", ["a", "b"]);
    network.edit("a", (text) => text.delete(1, 2));
    network.edit("b", (text) => {
      text.insert(2, "x");
      text.insert(3, "y");
    });
    network.exchange();
    expect(network.converged()).toBe("axyd");
  });

  test("where the letters were, also when the one before them is deleted since", () => {
    const network = new Network("abcde", ["a", "b"]);
    network.edit("b", (text) => text.insert(3, "x"));
    network.edit("a", (text) => {
      text.delete(2, 2);
      text.delete(1, 1);
    });
    network.send("a");
    network.send("b");
    network.sync("a");
    network.sync("b");
    expect(network.converged()).toBe("axe");
  });

  test("where the letters were, after a reload", () => {
    const network = new Network("abcd", ["a", "b", "c"]);
    network.edit("a", (text) => text.delete(1, 2));
    network.send("a");
    network.sync("c");
    network.reload("c");
    network.edit("b", (text) => text.insert(2, "x"));
    network.exchange();
    expect(network.converged()).toBe("axd");
  });

  test("at the start of a text that was emptied meanwhile", () => {
    const edits = {
      a: (text: Text) => text.delete(0, 2),
      b: (text: Text) => text.insert(0, "x"),
    };
    expect(race("ab", edits, ["a", "b"])).toBe("x");
  });
});

describe("an insert that arrives again", () => {
  test("changes nothing, whole or fused with the letters typed after it", () => {
    const { doc, text } = flat("ab");
    const first = sent(doc, () => text.insert(2, "c"));
    const second = sent(doc, () => text.insert(3, "d"));
    const peer = reload(flat("ab").doc);
    receive(peer, ...first);
    // DocSync fuses letters typed one after the other.
    receive(peer, mergeOperations(...first, ...second));
    receive(peer, ...first);
    expect(rootText(peer).get()).toBe("abcd");
    expect(runsOf(peer)).toStrictEqual([["abcd"]]);
  });

  test("is left out when a later letter of it is here: never two letters with one id", () => {
    const { doc, text } = flat("ab");
    const [batch] = sent(doc, () => text.insert(2, "cd"));
    const peer = reload(doc);
    sent(peer, () => rootText(peer).delete(2, 1));
    receive(peer, batch!);
    expect(rootText(peer).get()).toBe("abd");
  });
});

describe("the start of a node's text", () => {
  test("a node with a session is named as it is", () => {
    const doc = new Doc({ ...config(), id: ROOT_ID });
    const node = doc.createNode(Paragraph);
    doc.root.append(node);
    doc.forceCommit();
    const [batch] = sent(doc, () => node.state.t.insert(0, "hi"));
    expect(opsOf(batch!)).toStrictEqual([[3, "a", 0, "hi", `^${node.id}`]]);
  });

  test("a long id without a session, by a short prefix of its hash", () => {
    const doc = new Doc({
      ...config(),
      id: ROOT_ID,
      nodeIdGenerator: sessionIds("nodeid", "-"),
    });
    const nodes = [0, 1].map(() => doc.createNode(Paragraph));
    doc.root.append(...nodes);
    doc.forceCommit();
    const [first] = sent(doc, () => nodes[0]!.state.t.insert(0, "one"));
    const [second] = sent(doc, () => nodes[1]!.state.t.insert(0, "two"));
    expect(startOf(first!)).toMatch(/^#.{1,3}$/);
    expect(startOf(second!)).not.toBe(startOf(first!));
    // A node deleted since still names its text: it is stored.
    nodes[0]!.delete();
    doc.forceCommit();
    const third = sent(doc, () => nodes[1]!.state.t.insert(0, "2"));
    const loaded = Doc.fromJSON(
      { ...config("d"), id: doc.root.id },
      doc.toJSON(),
    );
    loaded.forceCommit();
    receive(loaded, ...third);
    const node = loaded.getNodeById(nodes[1]!.id);
    expect(node?.is(Paragraph) && node.state.t.get()).toBe("2two");
  });

  test("among many such nodes the prefix is longer; one several have names the first", () => {
    // A node of a session, which is never named by a hash.
    const start = new Doc({ ...config(), id: ROOT_ID });
    start.root.append(start.createNode(Paragraph));
    start.forceCommit();
    const doc = Doc.fromJSON(
      { ...config(), id: ROOT_ID, nodeIdGenerator: sessionIds("nodeid", "-") },
      start.toJSON(),
    );
    const made = Array.from({ length: 40 }, () => doc.createNode(Paragraph));
    doc.root.append(...made);
    doc.forceCommit();
    const json = doc.toJSON();
    const batches = made.flatMap((node, index) =>
      sent(doc, () => node.state.t.insert(0, `${index}`)),
    );
    const longest = Math.max(...batches.map((batch) => startOf(batch).length));
    expect(longest).toBeGreaterThan(2);
    // Here also others without a session the sender did not have: the
    // same on every replica that has them.
    const copies = [0, 1].map(() => {
      const copy = Doc.fromJSON(
        {
          ...config("c"),
          id: ROOT_ID,
          nodeIdGenerator: sessionIds("extra", "_"),
        },
        json,
      );
      for (let count = 0; count < 200; count++)
        copy.root.append(copy.createNode(Paragraph));
      copy.forceCommit();
      receive(copy, ...batches);
      return copy;
    });
    expect(stored(copies[0]!)).toBe(stored(copies[1]!));
    const texts: string[] = [];
    copies[0]!.root.children().forEach((node) => {
      if (node.is(Paragraph) && node.state.t.length > 0)
        texts.push(node.state.t.get());
    });
    expect(texts.length).toBe(40);
  });

  test("a prefix that names no node here: the letters are lost", () => {
    const { doc } = flat("ab");
    receive(doc, ["z.0", "x", "#zzz"]);
    expect(rootText(doc).get()).toBe("ab");
  });

  test("letters after lost ones are not inserted again, here or deleted since", () => {
    const { doc } = flat("ab");
    receive(doc, ["z.0", "x", "#zzz"]);
    receive(doc, ["z.1", "y", "^"]);
    receive(doc, ["z.3", "v", "^"]);
    // Fused with the lost one, as DocSync may send them again.
    receive(doc, ["z.0", "xy", "^"]);
    expect(rootText(doc).get()).toBe("vyab");
    sent(doc, () => rootText(doc).delete(1, 1));
    receive(doc, ["z.0", "xy", "^"]);
    expect(rootText(doc).get()).toBe("vab");
  });
});

describe("letters of the root's text", () => {
  test("a paragraph letter is a letter: Enter and Backspace", () => {
    const { doc, text } = flat(`Hello world${P}`);
    const [enter] = sent(doc, () => text.insert(6, P));
    expect(text.get()).toBe(`Hello ${P}world${P}`);
    const [backspace] = sent(doc, () => text.delete(6, 1));
    expect(text.get()).toBe(`Hello world${P}`);
    expect(JSON.stringify(enter).length).toBeLessThan(20);
    expect(JSON.stringify(backspace).length).toBeLessThan(16);
  });

  test("an index inside a surrogate pair moves after it", () => {
    const { doc, text } = flat("a😀b");
    text.insert(2, "x");
    expect(text.get()).toBe("a😀xb");
    // A range that starts and ends inside it is empty.
    text.delete(2, 1);
    expect(text.get()).toBe("a😀xb");
    text.delete(3, 1);
    doc.forceCommit();
    expect(text.get()).toBe("a😀b");
  });

  test("an empty text has no length, and an unknown edit changes nothing", () => {
    const { doc } = flat("ab");
    const node = doc.createNode(Paragraph);
    expect(node.state.t.length).toBe(0);
    receive(doc, ["z.0", -8, 1]);
    expect(rootText(doc).get()).toBe("ab");
  });

  test("an index out of the text is clamped to it", () => {
    const { doc, text } = flat("ab");
    text.insert(-3, "<");
    text.insert(99, ">");
    text.delete(-1, 2);
    text.delete(1, -1);
    text.insert(1, "");
    doc.forceCommit();
    expect(text.get()).toBe("ab>");
    expect(text.length).toBe(3);
  });
});

describe("inserts one after the other share a row", () => {
  test("each one's letters, then its references", () => {
    const { doc, text } = flat("abcd");
    const [batch] = sent(doc, () => {
      text.insert(1, "x");
      text.insert(4, "y");
    });
    expect(batch).toStrictEqual(["a.3", "x", -2, "y", -4]);
    const other = flat("abcd").doc;
    receive(other, batch!);
    expect(rootText(other).get()).toBe("axbcyd");
  });

  test("letters that read as a reference start a row of their own", () => {
    const { doc, text } = flat("abcd");
    const [batch] = sent(doc, () => {
      text.insert(1, "x");
      text.insert(3, "'");
      text.insert(5, "<");
      text.insert(7, "^z");
      text.insert(9, "#z");
      text.insert(11, "1.z");
      text.insert(13, ".z");
    });
    // `.z` does not read as a letter, but its reference is not a number.
    expect(batch).toStrictEqual([
      "a.3",
      ["x", -2],
      ["'", -3],
      ["<", -4],
      ["^z", 0, "'"],
      ["#z"],
      ["1.z"],
      [".z", "<"],
    ]);
    const other = flat("abcd").doc;
    receive(other, batch!);
    expect(rootText(other).get()).toBe(text.get());
  });
});

describe("mergeOperations with Base's text", () => {
  test("fuses letters typed one after the other", () => {
    const { doc, text } = flat("ab");
    const batches = [2, 3, 4].flatMap((at) =>
      sent(doc, () => text.insert(at, "x")),
    );
    expect(mergeOperations(...batches)).toStrictEqual(["a.1", "xxx"]);
  });

  test("does not fuse two inserts at a node's start", () => {
    const { doc, text } = flat("");
    const batches = [0, 0].flatMap(() => sent(doc, () => text.insert(0, "x")));
    expect(opsOf(mergeOperations(...batches))).toHaveLength(2);
  });

  test("keeps the node operations", () => {
    const doc = new Doc({ ...config(), id: ROOT_ID });
    doc.forceCommit();
    const operations = [
      ...sent(doc, () => {
        const node = doc.createNode(Paragraph);
        doc.root.append(node);
        node.state.t.insert(0, "ab");
      }),
      ...sent(doc, () => rootText(doc).insert(0, "c")),
    ];
    const [ordered] = decode(mergeOperations(...operations));
    expect(ordered.filter((operation) => operation[0] === 0)).toHaveLength(1);
    expect(runsOf(doc)).toStrictEqual([["c"], ["ab"]]);
  });
});
