import {
  Doc,
  mergeOperations,
  type Json,
  type JsonTree,
  type Operations,
  _INTERNAL_decodeOperations as decode,
} from "@docukit/docnode";
import { describe, expect, test } from "vitest";
import { jsonTree } from "../utils.js";

import {
  assertWellFormed,
  backspaceJoin,
  Cluster,
  config,
  enter,
  fromZ,
  inZ,
  orderedCluster,
  Paragraph,
  paragraphs,
  reload,
  runsOf,
} from "./utils.js";

const stored = (doc: Doc) => JSON.stringify(doc.root.toJSON());

function textsOf(doc: Doc) {
  const texts: string[] = [];
  doc.root.children().forEach((node) => {
    if (node.is(Paragraph)) texts.push(node.state.t.get());
  });
  return texts;
}

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
});

describe("format", () => {
  test("typing at the edge extends only an inherited format", () => {
    const { nodes } = paragraphs(["ab"]);
    const text = nodes[0]!.state.t;
    text.format(0, 2, "bold", true);
    text.format(0, 2, "color", "red");
    text.insert(2, "c");
    expect(text.spans()).toStrictEqual([
      { text: "ab", attrs: { bold: true, color: "red" } },
      { text: "c", attrs: { bold: true } },
    ]);
  });

  test("an empty range records nothing", () => {
    const { doc, nodes } = paragraphs(["ab"]);
    let changes = 0;
    doc.onChange(() => changes++);
    nodes[0]!.state.t.format(1, 1, "bold", true);
    doc.forceCommit();
    expect(changes).toBe(0);
  });

  test("undo of a format that reaches the end of the text, also after reload", () => {
    const { doc, nodes } = paragraphs(["ab"], true);
    nodes[0]!.state.t.format(0, 2, "bold", true);
    doc.forceCommit();
    const formatted = reload(doc);
    expect(textNode(formatted).state.t.spans()).toStrictEqual([
      { text: "ab", attrs: { bold: true } },
    ]);
    doc.undoManager.undo();
    expect(nodes[0]!.state.t.spans()).toStrictEqual([
      { text: "ab", attrs: {} },
    ]);
    const unformatted = reload(doc);
    expect(textNode(unformatted).state.t.spans()).toStrictEqual([
      { text: "ab", attrs: {} },
    ]);
    expect(unformatted.toJSON()).toStrictEqual(doc.toJSON());
  });
});

function textNode(doc: Doc) {
  const node = doc.root.first;
  if (!node?.is(Paragraph)) throw new Error("no paragraph");
  return node;
}

describe("concurrent formats of the same key", () => {
  test("the later session wins the overlap on every replica", () => {
    const cluster = orderedCluster(["abcd"], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () =>
      cluster.node(0, id).state.t.format(0, 3, "color", "red"),
    );
    cluster.edit(1, () =>
      cluster.node(1, id).state.t.format(1, 4, "color", "blue"),
    );
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.spans(0, id)).toStrictEqual([
      { text: "a", attrs: { color: "red" } },
      { text: "bcd", attrs: { color: "blue" } },
    ]);
    expect(cluster.spans(1, id)).toStrictEqual(cluster.spans(0, id));
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

describe("joins", () => {
  test("joining into a paragraph that never had text", () => {
    const { doc, nodes } = paragraphs(["", "text"]);
    backspaceJoin(nodes[0]!, nodes[1]!);
    doc.forceCommit();
    expect(textsOf(doc)).toStrictEqual(["text"]);
    expect(textsOf(reload(doc))).toStrictEqual(["text"]);
  });

  test("joining a paragraph that never had text changes nothing", () => {
    const { doc, nodes } = paragraphs(["text", ""]);
    backspaceJoin(nodes[0]!, nodes[1]!);
    doc.forceCommit();
    expect(textsOf(doc)).toStrictEqual(["text"]);
  });
});

describe("undoing a join while peers keep editing", () => {
  test("a format across the join stays with the text before it", () => {
    const cluster = orderedCluster(["ab", "cd"], 2, true);
    const [first, second] = cluster.ids as [string, string];
    cluster.edit(0, () =>
      backspaceJoin(cluster.node(0, first), cluster.node(0, second)),
    );
    cluster.deliverAll();
    cluster.edit(1, () =>
      cluster.node(1, first).state.t.format(0, 4, "bold", true),
    );
    cluster.deliverAll();
    cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.spans(0, first)).toStrictEqual([
      { text: "ab", attrs: { bold: true } },
    ]);
    expect(cluster.spans(0, second)).toStrictEqual([{ text: "cd", attrs: {} }]);
  });
});

describe("concurrent inserts after the same character", () => {
  test("they are ordered by their right origins, then by session", () => {
    const cluster = orderedCluster(["n"], 3);
    const id = cluster.ids[0]!;
    // Two replicas type before "n" at the same time.
    const [a] = cluster.edit(0, () =>
      cluster.node(0, id).state.t.insert(0, "a"),
    );
    const [l] = cluster.edit(1, () =>
      cluster.node(1, id).state.t.insert(0, "L"),
    );
    cluster.deliver(a!, 2);
    cluster.deliver(l!, 2);
    expect(cluster.text(2, id)).toBe("aLn");
    // Both type right after "a": one before it sees "L", the other after.
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(1, "X"));
    cluster.edit(2, () => cluster.node(2, id).state.t.insert(1, "Y"));
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("aXYLn");
  });

  test("a peer's insert inside a run keeps the run whole", () => {
    const cluster = orderedCluster([""], 3);
    const id = cluster.ids[0]!;
    const [a] = cluster.edit(0, () =>
      cluster.node(0, id).state.t.insert(0, "a"),
    );
    cluster.deliver(a!, 1);
    cluster.deliver(a!, 2);
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(1, "b"));
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(2, "c"));
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(1, "X"));
    cluster.edit(2, () => cluster.node(2, id).state.t.insert(1, "Z"));
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("abcXZ");
  });
});

describe("a format of what was just typed", () => {
  test("names the letter by its distance and reaches every replica", () => {
    const cluster = orderedCluster(["Hello"], 2);
    const id = cluster.ids[0]!;
    const [event] = cluster.edit(0, () => {
      cluster.node(0, id).state.t.insert(2, "X");
      cluster.node(0, id).state.t.format(2, 3, "bold", true);
    });
    // `[-2, lamport, key, ranges, value]`: the letter one counter back.
    expect(event!.operations).toContainEqual([-2, 1, "bold", 1, true]);
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.node(1, id).state.t.spans()).toStrictEqual([
      { text: "He", attrs: {} },
      { text: "X", attrs: { bold: true } },
      { text: "llo", attrs: {} },
    ]);
  });
});

describe("mergeOperations with text edits", () => {
  function typed(texts: [index: number, text: string][]) {
    const { doc, nodes } = paragraphs([""]);
    const operations: Operations[] = [];
    doc.onChange((event) => operations.push(event.operations));
    for (const [index, text] of texts) {
      nodes[0]!.state.t.insert(index, text);
      doc.forceCommit();
    }
    return operations;
  }

  test("fuses a run typed after a character the same session typed", () => {
    const [, b, c] = typed([
      [0, "a"],
      [1, "b"],
      [2, "c"],
    ]);
    // One insert, written without its brackets.
    expect(mergeOperations(b!, c!).slice(1)).toStrictEqual(["bc"]);
  });

  test("a letter typed mid-run says it is a left child by its sign, and fuses", () => {
    const cluster = orderedCluster([""], 2);
    const id = cluster.ids[0]!;
    const type = (index: number, text: string) =>
      cluster.edit(0, () => cluster.node(0, id).state.t.insert(index, text))[0]!
        .operations;
    type(0, "abc");
    cluster.deliverAll();
    const x = type(1, "x");
    const y = type(2, "y");
    // `[head, "x", -(counter of b + 1)]`: a left child of "b", so no parent.
    expect(x.slice(1)).toStrictEqual(["x", -2]);
    const merged = mergeOperations(x, y);
    expect(merged[1]).toBe("xy");
    cluster.docs[1]!.applyOperations(merged);
    cluster.docs[1]!.forceCommit();
    expect(cluster.text(1, id)).toBe("axybc");
  });

  test("a batch of many sessions names each of them once", () => {
    const cluster = orderedCluster([""], 10);
    const id = cluster.ids[0]!;
    const type = (replica: number, text: string) =>
      cluster.edit(replica, () =>
        cluster.node(replica, id).state.t.insert(0, text),
      )[0]!.operations;
    const replicas = cluster.docs.map((_, replica) => replica);
    const typed = replicas.map((replica) => type(replica, "x"));
    const again = replicas.map((replica) => type(replica, "y"));
    const merged = mergeOperations(...typed, ...again);
    const [head] = merged;
    expect(new Set(head).size).toBe(head.length);
    expect(head.length).toBeGreaterThan(9);
    cluster.docs[0]!.applyOperations(merged);
    cluster.docs[0]!.forceCommit();
    cluster.deliverAll();
    cluster.assertConverged();
  });

  test("inserts at scattered places of one transaction travel in one row", () => {
    const cluster = orderedCluster([""], 2);
    const id = cluster.ids[0]!;
    const text = () => cluster.node(0, id).state.t;
    cluster.edit(0, () => text().insert(0, "abcdefgh"));
    const [entry] = cluster.edit(0, () => {
      for (const index of [6, 1, 4, 2]) text().insert(index, "x");
    });
    // `-3`, then each insert's letters and references, without brackets.
    expect(entry!.operations.slice(1)).toStrictEqual([
      -3,
      ...["x", -7, "x", -2, "x", -4, "x", 2, 2],
    ]);
    cluster.deliverAll();
    expect(cluster.text(1, id)).toBe("axxbcxdefxgh");
    cluster.assertConverged();
  });

  test("a node inserted between two inserts keeps its own row", () => {
    const cluster = orderedCluster(["abc"], 2);
    const id = cluster.ids[0]!;
    cluster.deliverAll();
    cluster.edit(0, (doc) => {
      const text = cluster.node(0, id).state.t;
      text.insert(1, "x");
      doc.root.append(doc.createNode(Paragraph));
      text.insert(2, "y");
    });
    cluster.deliverAll();
    expect(cluster.texts(1)).toStrictEqual(["axybc", ""]);
    cluster.assertConverged();
  });

  test("typing backwards names the letter just typed as `<`", () => {
    const cluster = orderedCluster(["a"], 2);
    const id = cluster.ids[0]!;
    const type = (text: string) =>
      cluster.edit(0, () => cluster.node(0, id).state.t.insert(0, text))[0]!
        .operations;
    type("b");
    // A left child of the letter just before it.
    expect(type("c").slice(1)).toStrictEqual(["c", "<"]);
    cluster.deliverAll();
    expect(cluster.text(1, id)).toBe("cba");
    cluster.assertConverged();
  });

  test("does not fuse a jump to another place or a deletion", () => {
    const { doc, nodes } = paragraphs(["xy"]);
    const operations: Operations[] = [];
    doc.onChange((event) => operations.push(event.operations));
    const text = nodes[0]!.state.t;
    text.insert(2, "a");
    doc.forceCommit();
    text.insert(0, "b");
    doc.forceCommit();
    text.delete(0, 1);
    doc.forceCommit();
    expect(decode(mergeOperations(...operations))[0]).toHaveLength(3);
  });

  test("a batch of only an insert with a first state keeps its brackets", () => {
    const { nodes } = paragraphs(["ab"]);
    const first = nodes[0]!.id;
    const insert = fromZ([first], [["x", "0"], 0, `^${inZ(first)}`]);
    expect(mergeOperations(insert)).toStrictEqual(insert);
  });

  test("fuses letters typed one after the other with the same first state", () => {
    const { doc, nodes } = paragraphs([""]);
    const operations: Operations[] = [];
    doc.onChange((event) => operations.push(event.operations));
    // `color` is not inherited: each letter says it.
    for (const [index, letter] of [...["a", "b"]].entries()) {
      nodes[0]!.state.t.insert(index, letter, { color: "red" });
      doc.forceCommit();
    }
    nodes[0]!.state.t.insert(2, "c");
    doc.forceCommit();
    const [ordered] = decode(mergeOperations(...operations));
    expect(ordered.map((operation) => operation[3])).toStrictEqual([
      ["ab", { color: "red" }],
      "c",
    ]);
  });
});

describe("delivery", () => {
  test("unknown edit kinds from a newer version are ignored", () => {
    const { doc, nodes } = paragraphs(["ab"]);
    const before = JSON.stringify(doc.toJSON());
    doc.applyOperations(["x.-", -99, 0]);
    doc.forceCommit();
    expect(JSON.stringify(doc.toJSON())).toBe(before);
    expect(nodes[0]!.state.t.get()).toBe("ab");
  });

  test("a replica saved while waiting for a missing edit resumes after reload", () => {
    const cluster = new Cluster(["ab"], 3);
    const id = cluster.ids[0]!;
    const [insert] = cluster.edit(0, () =>
      cluster.node(0, id).state.t.insert(1, "X"),
    );
    cluster.deliver(insert!, 1);
    const [remove] = cluster.edit(1, () =>
      cluster.node(1, id).state.t.delete(1, 1),
    );
    cluster.deliver(remove!, 2);
    const reloaded = Doc.fromJSON(
      { ...config(), id: cluster.docs[2]!.root.id },
      cluster.docs[2]!.toJSON(),
    );
    reloaded.forceCommit();
    reloaded.applyOperations(insert!.operations, { skipUndo: true });
    reloaded.forceCommit();
    expect(textNode(reloaded).state.t.get()).toBe("ab");
    cluster.deliverAll();
    expect(JSON.stringify(reloaded.root.toJSON()[2])).toBe(
      JSON.stringify(cluster.textStateOf(0)),
    );
  });
});

describe("edits that wait for the Enter they depend on", () => {
  test("typing and joining after an Enter a replica has not seen", () => {
    const cluster = new Cluster(["ab", "cd", "ef"], 2);
    const [first, second, third] = cluster.ids as [string, string, string];
    const [split] = cluster.edit(0, (doc) => {
      enter(doc, cluster.node(0, first), 2);
    });
    const [join] = cluster.edit(0, () =>
      backspaceJoin(cluster.node(0, first), cluster.node(0, second)),
    );
    // Joined right before the new paragraph: both refer to it as right origin.
    const [joinAgain] = cluster.edit(0, () =>
      backspaceJoin(cluster.node(0, first), cluster.node(0, third)),
    );
    const [typed] = cluster.edit(0, () =>
      cluster.node(0, first).state.t.insert(6, "X"),
    );
    expect(cluster.texts(0)).toStrictEqual(["abcdefX", ""]);
    for (const entry of [typed, joinAgain, join, split])
      cluster.deliver(entry!, 1);
    cluster.assertConverged();
  });
});

describe("node id generators", () => {
  // The text session is the id prefix before the last dot: a reloaded
  // document names the same one, and its counter goes on.
  test("a reloaded document that reuses the id prefix keeps new inserts", () => {
    let clock = 0;
    const nodeIdGenerator = {
      generate: () => `alice.${clock++}`,
      validate: () => true,
    };
    const { doc } = paragraphs(["a"]);
    const json = doc.toJSON();
    const first = Doc.fromJSON(
      { id: doc.root.id, ...config(), nodeIdGenerator },
      json,
    );
    textNode(first).state.t.insert(1, "b");
    first.forceCommit();
    const second = Doc.fromJSON(
      { id: first.root.id, ...config(), nodeIdGenerator },
      first.toJSON(),
    );
    textNode(second).state.t.insert(2, "c");
    expect(textNode(second).state.t.get()).toBe("abc");
  });

  // Deletes take no id: a reused session cannot clash with an older one.
  test("a reloaded document that reuses the id prefix keeps new deletes", () => {
    let clock = 0;
    const nodeIdGenerator = {
      generate: () => `alice.${clock++}`,
      validate: () => true,
    };
    const { doc } = paragraphs(["abc"]);
    const first = Doc.fromJSON(
      { id: doc.root.id, ...config(), nodeIdGenerator },
      doc.toJSON(),
    );
    textNode(first).state.t.delete(0, 1);
    first.forceCommit();
    const second = Doc.fromJSON(
      { id: first.root.id, ...config(), nodeIdGenerator },
      first.toJSON(),
    );
    textNode(second).state.t.delete(0, 1);
    expect(textNode(second).state.t.get()).toBe("c");
  });
});

describe("a reloaded document", () => {
  test("deleting letters next to deleted ones joins them", () => {
    const { doc, nodes } = paragraphs(["abcd"]);
    nodes[0]!.state.t.delete(2, 1);
    doc.forceCommit();
    const copy = reload(doc);
    textNode(copy).state.t.delete(0, 2);
    copy.forceCommit();
    expect(textNode(copy).state.t.get()).toBe("d");
    expect(runsOf(copy)).toStrictEqual([["---", "d"]]);
  });
});

describe("stored format", () => {
  /** Backspaces each letter of `text`, from the last one, one at a time. */
  function backspaced(text: string, keep: number) {
    const { doc, nodes } = paragraphs([text]);
    for (let index = text.length; index > keep; index--) {
      nodes[0]!.state.t.delete(index - 1, 1);
      doc.forceCommit();
    }
    return { doc, text: nodes[0]!.state.t };
  }

  test("letters deleted one at a time are stored as one run", () => {
    const { doc, text } = backspaced("0123456789".repeat(20), 0);
    expect(text.get()).toBe("");
    // About the size of the 200 letters themselves, not a run per letter.
    expect(stored(doc).length).toBeLessThan(400);
    expect(reload(doc).root.toJSON()).toStrictEqual(doc.root.toJSON());
  });

  test("letters deleted forward one at a time are stored as one run", () => {
    const { doc, nodes } = paragraphs(["0123456789".repeat(20)]);
    for (let count = 0; count < 200; count++) {
      nodes[0]!.state.t.delete(0, 1);
      doc.forceCommit();
    }
    expect(stored(doc).length).toBeLessThan(400);
    expect(reload(doc).root.toJSON()).toStrictEqual(doc.root.toJSON());
  });

  test("deletes whose ids go up by other steps, or come from other sessions", () => {
    const cluster = orderedCluster(["0123456789"], 2);
    const id = cluster.ids[0]!;
    // Forward deletes with a format in between: delete ids go up by 2.
    cluster.edit(0, (doc) => {
      for (let index = 0; index < 4; index++) {
        cluster.node(0, id).state.t.delete(0, 1);
        doc.forceCommit();
        cluster.node(0, id).state.t.format(0, 1, "bold", index % 2 === 0);
        doc.forceCommit();
      }
    });
    cluster.edit(1, (doc) => {
      for (let index = 10; index > 6; index--) {
        cluster.node(1, id).state.t.delete(index - 1, 1);
        doc.forceCommit();
      }
    });
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("45");
    const doc = cluster.docs[0]!;
    expect(reload(doc).root.toJSON()).toStrictEqual(doc.root.toJSON());
  });

  test("what follows letters typed in the middle of a run continues it", () => {
    const { doc, nodes } = paragraphs(["0123456789".repeat(10)]);
    // From the end, so each letter cuts a run of the original text.
    for (let index = 90; index > 0; index -= 10) {
      nodes[0]!.state.t.insert(index, "x");
      doc.forceCommit();
    }
    expect(nodes[0]!.state.t.get()).toBe(
      Array.from({ length: 10 }, () => "0123456789").join("x"),
    );
    // Each cut costs a few characters, not a parent and two counter jumps.
    expect(stored(doc).length).toBeLessThan(360);
    expect(reload(doc).root.toJSON()).toStrictEqual(doc.root.toJSON());
  });

  test("letters deleted one at a time where a join was survive a reload", () => {
    const cluster = orderedCluster(["ab", "cd"], 2, true);
    const [ab, cd] = cluster.ids as [string, string];
    cluster.edit(0, () =>
      backspaceJoin(cluster.node(0, ab), cluster.node(0, cd)),
    );
    cluster.deliverAll();
    cluster.edit(1, () => cluster.node(1, ab).state.t.insert(2, "XYZ"));
    cluster.deliverAll();
    for (let count = 0; count < 3; count++)
      cluster.edit(1, () => cluster.node(1, ab).state.t.delete(2, 1));
    cluster.deliverAll();
    // Undoing the join leaves those letters before the root of "cd".
    cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.deliverAll();
    const doc = cluster.docs[0]!;
    expect(reload(doc).root.toJSON()).toStrictEqual(doc.root.toJSON());
  });

  test("a word typed mid-text and then fixed stores the rest in a few characters", () => {
    const { doc, nodes } = paragraphs(["0123456789".repeat(1000)]);
    const text = nodes[0]!.state.t;
    // From the end, so each word cuts a run of the original text.
    for (let at = 9000; at > 0; at -= 100) {
      text.insert(at, "word");
      doc.forceCommit();
      text.insert(at + 2, "X");
      doc.forceCommit();
    }
    // The 10,000 letters, then about 50 characters for each fixed word: its
    // parent is written as a small step back from its own counter.
    expect(stored(doc).length).toBeLessThan(15200);
    expect(reload(doc).root.toJSON()).toStrictEqual(doc.root.toJSON());
  });

  test("marks of two sessions, to the end, undone and over what was just typed", () => {
    const cluster = orderedCluster(["Hello world"], 2, true);
    const id = cluster.ids[0]!;
    cluster.edit(0, () =>
      cluster.node(0, id).state.t.format(0, 5, "bold", true),
    );
    cluster.edit(1, () =>
      cluster.node(1, id).state.t.format(6, 11, "italic", true),
    );
    cluster.edit(1, (doc) => doc.undoManager.undo());
    cluster.edit(1, () =>
      cluster.node(1, id).state.t.format(3, 8, "italic", true),
    );
    cluster.deliverAll();
    // Typed and formatted at once, as an editor does inside a bold word.
    cluster.edit(0, () => {
      cluster.node(0, id).state.t.insert(2, "X");
      cluster.node(0, id).state.t.format(2, 3, "underline", true);
    });
    cluster.deliverAll();
    cluster.assertConverged();
    const doc = cluster.docs[0]!;
    const reloaded = reload(doc);
    expect(reloaded.root.toJSON()).toStrictEqual(doc.root.toJSON());
    expect(textsOf(reloaded)).toStrictEqual(["HeXllo world"]);
    const node = reloaded.getNodeById(id);
    if (!node?.is(Paragraph)) throw new Error("Expected the paragraph");
    expect(node.state.t.spans()).toStrictEqual(
      cluster.node(0, id).state.t.spans(),
    );
  });

  /** A stored document of one or two paragraphs with the stored text `text`. */
  const storedDoc = (
    text: Json[],
    first: string,
    second?: string,
  ): JsonTree => [
    "01kc52hq510g6y44jhq0wqrjb3",
    "root",
    { "~t": text },
    second === undefined
      ? [[first, "p", {}]]
      : [
          [first, "p", {}],
          [second, "p", {}],
        ],
  ];

  test("letters typed each before the last load and store as before", () => {
    const { doc, nodes } = paragraphs(["a"]);
    for (const letter of "bcdefghij") {
      nodes[0]!.state.t.insert(0, letter);
      doc.forceCommit();
    }
    const copy = reload(doc);
    expect(textsOf(copy)).toStrictEqual(["jihgfedcba"]);
    expect(copy.toJSON()).toStrictEqual(doc.toJSON());
  });

  test("a text of a format before 9, never released, does not load", () => {
    const json = storedDoc([8, ["s"], "ab", [["s.0", 2]]], "s.0");
    expect(() => Doc.fromJSON(config(), json)).toThrowError(
      "Unsupported text format: 8",
    );
  });
});

describe("deleted letters are not stored", () => {
  test("the stored text has only the letters that are visible", () => {
    const { doc, nodes } = paragraphs(["Hello brave new world"]);
    nodes[0]!.state.t.delete(5, 10);
    doc.forceCommit();
    expect(stored(doc)).not.toContain("brave");
    expect(textsOf(reload(doc))).toStrictEqual(["Hello world"]);
  });

  test("an undo brings them back after a reload, with the history kept", () => {
    const { doc, nodes } = paragraphs(["Hello brave new world"], true);
    nodes[0]!.state.t.delete(5, 10);
    doc.forceCommit();
    const copy = Doc.fromJSON(
      { ...config(true), id: doc.root.id },
      doc.toJSON(),
    );
    copy.forceCommit();
    copy.undoManager.importHistory(doc.undoManager.exportHistory());
    copy.undoManager.undo();
    copy.forceCommit();
    expect(textsOf(copy)).toStrictEqual(["Hello brave new world"]);
  });

  test("a peer's undo brings them back in a replica rebuilt from storage", () => {
    const cluster = orderedCluster(["Hello brave new world"], 2, true);
    const id = cluster.ids[0]!;
    const [remove] = cluster.edit(0, () =>
      cluster.node(0, id).state.t.delete(5, 10),
    );
    // Replica 1 is rebuilt from its stored text, like a DocSync client.
    const rebuilt = reload(cluster.docs[1]!);
    rebuilt.applyOperations(remove!.operations, { skipUndo: true });
    rebuilt.forceCommit();
    expect(textsOf(rebuilt)).toStrictEqual(["Hello world"]);
    const [undo] = cluster.edit(0, (doc) => doc.undoManager.undo());
    rebuilt.applyOperations(undo!.operations, { skipUndo: true });
    rebuilt.forceCommit();
    expect(textsOf(rebuilt)).toStrictEqual(["Hello brave new world"]);
    expect(reload(rebuilt).root.toJSON()).toStrictEqual(
      cluster.docs[0]!.root.toJSON(),
    );
  });
});

describe("serialization", () => {
  test("a letter typed where a join was survives a reload after undoing the join", () => {
    const cluster = orderedCluster(["ab", "cd"], 2, true);
    const [ab, cd] = cluster.ids as [string, string];
    cluster.edit(0, () =>
      backspaceJoin(cluster.node(0, ab), cluster.node(0, cd)),
    );
    cluster.deliverAll();
    cluster.edit(1, () => cluster.node(1, ab).state.t.insert(2, "X"));
    cluster.deliverAll();
    // Replica 1 deletes that letter while replica 0 undoes the join and is
    // then rebuilt from its stored text, like a DocSync client.
    const [remove] = cluster.edit(1, () =>
      cluster.node(1, ab).state.t.delete(2, 1),
    );
    cluster.edit(0, (doc) => doc.undoManager.undo());
    const rebuilt = reload(cluster.docs[0]!);
    rebuilt.applyOperations(remove!.operations, { skipUndo: true });
    rebuilt.forceCommit();
    cluster.deliverAll();
    expect(rebuilt.root.toJSON()).toStrictEqual(cluster.docs[0]!.root.toJSON());
  });

  test("node ids without a session separator", () => {
    let clock = 0;
    const doc = new Doc({
      ...config(),
      nodeIdGenerator: { generate: () => `n${clock++}`, validate: () => true },
    });
    for (const text of ["a", "b"]) {
      const node = doc.createNode(Paragraph);
      doc.root.append(node);
      node.state.t.insert(0, text);
    }
    doc.forceCommit();
    const copy = Doc.fromJSON(
      {
        id: doc.root.id,
        ...config(),
        nodeIdGenerator: {
          generate: () => `m${clock++}`,
          validate: () => true,
        },
      },
      doc.toJSON(),
    );
    expect(textsOf(copy)).toStrictEqual(["a", "b"]);
  });

  test("consecutive paragraphs are stored compactly and reload", () => {
    const { doc, nodes } = paragraphs(["a", "b", "", "d"], true);
    // A join into the empty paragraph, undone, leaves it an empty text list.
    backspaceJoin(nodes[2]!, nodes[3]!);
    doc.forceCommit();
    doc.undoManager.undo();
    expect(textsOf(doc)).toStrictEqual(["a", "b", "", "d"]);
    const copy = reload(doc);
    expect(textsOf(copy)).toStrictEqual(["a", "b", "", "d"]);
    expect(copy.toJSON()).toStrictEqual(doc.toJSON());
  });

  test("a run is stored the same whichever way a peer's insert split it", () => {
    const cluster = orderedCluster(["a"], 3);
    const id = cluster.ids[0]!;
    const [c] = cluster.edit(0, () =>
      cluster.node(0, id).state.t.insert(1, "c"),
    );
    cluster.deliver(c!, 1);
    cluster.deliver(c!, 2);
    // Replica 1 types after "c" before it sees the "b" typed right after it.
    const [x] = cluster.edit(1, () =>
      cluster.node(1, id).state.t.insert(2, "X"),
    );
    cluster.deliver(x!, 2);
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(2, "b"));
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("acbX");
    expect(cluster.stateJson(2)).toBe(cluster.stateJson(0));
  });

  test("a join after an Enter reloads", () => {
    const { doc, nodes } = paragraphs(["ab", "cd"]);
    enter(doc, nodes[0]!, 2);
    backspaceJoin(nodes[0]!, nodes[1]!);
    doc.forceCommit();
    const copy = reload(doc);
    expect(textsOf(copy)).toStrictEqual(["abcd", ""]);
    expect(copy.toJSON()).toStrictEqual(doc.toJSON());
  });

  test("an unknown stored text value loads as empty text", () => {
    const { doc } = paragraphs(["ab"]);
    const json = jsonTree(doc);
    json[2] = { ...json[2], "~t": "{}" };
    const copy = Doc.fromJSON({ ...config(), id: doc.root.id }, json);
    expect(textNode(copy).state.t.get()).toBe("");
  });

  test("a root text value that is not a text store cannot be stored", () => {
    const { doc } = paragraphs(["ab"]);
    Object.assign(doc.root["_state"], { "~t": "corrupt" });
    expect(() => doc.toJSON()).toThrowError("Expected a text store");
  });
});

describe("undo history of text edits", () => {
  test("exports and imports text-only steps", () => {
    const { doc, nodes } = paragraphs(["ab"], true);
    nodes[0]!.state.t.insert(2, "c");
    doc.forceCommit();
    const history = doc.undoManager.exportHistory();
    const copy = Doc.fromJSON(
      { ...config(true), id: doc.root.id },
      doc.toJSON(),
    );
    copy.forceCommit();
    copy.undoManager.importHistory(history);
    copy.undoManager.undo();
    expect(textNode(copy).state.t.get()).toBe("ab");
  });

  test("a document without undo imports no steps", () => {
    const { doc, nodes } = paragraphs(["ab"], true);
    nodes[0]!.state.t.insert(2, "c");
    doc.forceCommit();
    const history = doc.undoManager.exportHistory();
    const copy = Doc.fromJSON({ ...config(), id: doc.root.id }, doc.toJSON());
    copy.forceCommit();
    copy.undoManager.importHistory(history);
    expect(copy.undoManager.canUndo()).toBe(false);
  });
});

describe("letter state and the edges of the three operations", () => {
  const P = (doc: Doc) => doc.root.first!.id;

  test("letters of one session put at the same place go in counter order", () => {
    const { doc } = paragraphs(["ab"]);
    const node = `^${inZ(P(doc))}`;
    doc.applyOperations(fromZ([P(doc)], ["x", 0, node], ["y", 0, node]));
    doc.forceCommit();
    const text = textsOf(doc)[0]!;
    expect(text.indexOf("x")).toBeLessThan(text.indexOf("y"));
    expect(textsOf(reload(doc))).toStrictEqual([text]);
  });

  test("typing with an object state continues the run of the letters before", () => {
    const { doc, nodes } = paragraphs([""]);
    const link = { link: { url: "https://a" } };
    nodes[0]!.state.t.insert(0, "ab", link);
    doc.forceCommit();
    nodes[0]!.state.t.insert(2, "cd", { link: { url: "https://a" } });
    doc.forceCommit();
    expect(runsOf(doc)).toStrictEqual([["abcd"]]);
    expect(nodes[0]!.state.t.spans()).toStrictEqual([
      { text: "abcd", attrs: link },
    ]);
  });

  test("a first state of only removed keys is none", () => {
    const { doc, nodes } = paragraphs([""]);
    nodes[0]!.state.t.insert(0, "ab", { bold: null });
    const node = `^${inZ(P(doc))}`;
    doc.applyOperations(
      fromZ(
        [P(doc)],
        [["q", { bold: null }], 0, node],
        // A first state of a kind this version does not know is ignored.
        [["r", 5], 0, node],
      ),
    );
    doc.forceCommit();
    const [span, ...rest] = nodes[0]!.state.t.spans();
    expect(rest).toStrictEqual([]);
    expect(span!.attrs).toStrictEqual({});
    expect([...span!.text].sort().join("")).toBe("abqr");
  });

  test("an insert without letters, or a delete of a node's start, changes nothing", () => {
    const { doc } = paragraphs(["ab"]);
    const before = JSON.stringify(doc.toJSON());
    doc.applyOperations(fromZ([P(doc)], [[5], 0, `^${inZ(P(doc))}`]));
    doc.applyOperations(fromZ([P(doc)], [-1, `^${inZ(P(doc))}`]));
    // Ranges of no letters, or with no length.
    doc.applyOperations(fromZ([P(doc)], [-1, [1, 0, 2]]));
    doc.forceCommit();
    expect(JSON.stringify(doc.toJSON())).toBe(before);
  });

  test("an undo of a delete at the end inserts each format again", () => {
    const { doc, nodes } = paragraphs(["ab"], true);
    const t = nodes[0]!.state.t;
    t.insert(2, "cd", { bold: true });
    doc.forceCommit();
    const spans = t.spans();
    t.delete(0, 4);
    doc.forceCommit();
    doc.undoManager.undo();
    doc.forceCommit();
    expect(t.spans()).toStrictEqual(spans);
  });

  test("an undo of a delete whose letters the document lacks does nothing", () => {
    const { doc, nodes } = paragraphs([""], true);
    const empty = doc.toJSON();
    nodes[0]!.state.t.insert(0, "hello");
    doc.forceCommit();
    nodes[0]!.state.t.delete(1, 3);
    doc.forceCommit();
    const history = doc.undoManager.exportHistory();
    const copy = Doc.fromJSON({ ...config(true), id: doc.root.id }, empty);
    copy.forceCommit();
    copy.undoManager.importHistory(history);
    copy.undoManager.undo();
    copy.forceCommit();
    expect(textsOf(copy)).toStrictEqual([""]);
  });

  test("a document as a JSON tree keeps its text and its state", () => {
    const { doc, nodes } = paragraphs(["hello"]);
    nodes[0]!.state.t.format(1, 3, "bold", true);
    doc.forceCommit();
    const copy = Doc.fromJSON(config(), jsonTree(doc));
    copy.forceCommit();
    expect(textNode(copy).state.t.spans()).toStrictEqual(
      nodes[0]!.state.t.spans(),
    );
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
