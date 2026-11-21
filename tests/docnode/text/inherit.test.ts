import { describe, expect, test } from "vitest";

import {
  checkTextUndo,
  config,
  orderedCluster,
  paragraphs,
  Paragraph,
  reload,
  runsOf,
} from "./utils.js";
import { defineNode, defineText, Doc, type Operations } from "@docukit/docnode";
import { labelsEngine } from "@docukit/docnode/crdt";

/** The batches a local edit sends. */
function sent(doc: Doc, edit: () => void): Operations[] {
  const out: Operations[] = [];
  const off = doc.onChange((event) => out.push(event.operations));
  edit();
  doc.forceCommit();
  off();
  return out;
}

const bytes = (batches: Operations[]) =>
  batches.reduce((sum, batch) => sum + JSON.stringify(batch).length, 0);

describe("inherited state", () => {
  test("a letter typed after a bold one is bold and sends no state", () => {
    const { doc, nodes } = paragraphs(["ab"]);
    const text = nodes[0]!.state.t;
    text.format(0, 2, "bold", true);
    doc.forceCommit();
    const batches = sent(doc, () => text.insert(2, "c", { bold: true }));
    expect(JSON.stringify(batches)).not.toContain("bold");
    expect(text.spans()).toStrictEqual([
      { text: "abc", attrs: { bold: true } },
    ]);
  });

  test("a letter typed without bold after a bold one says so", () => {
    const { doc, nodes } = paragraphs(["ab"]);
    const text = nodes[0]!.state.t;
    text.format(0, 2, "bold", true);
    doc.forceCommit();
    text.insert(2, "c", {});
    expect(text.spans()).toStrictEqual([
      { text: "ab", attrs: { bold: true } },
      { text: "c", attrs: {} },
    ]);
  });

  test("letters typed without attributes have what they inherit", () => {
    const { nodes } = paragraphs(["see here."]);
    const text = nodes[0]!.state.t;
    text.format(0, 3, "bold", true);
    text.format(4, 8, "link", "https://x");
    text.insert(3, "!");
    text.insert(9, "!");
    text.insert(7, "-");
    expect(text.spans()).toStrictEqual([
      { text: "see!", attrs: { bold: true } },
      { text: " ", attrs: {} },
      { text: "he-re", attrs: { link: "https://x" } },
      { text: "!.", attrs: {} },
    ]);
  });

  test("a rule may name every key that starts the same", () => {
    const Commented = defineNode({
      type: "c",
      state: { t: defineText({ inherit: { "comment:*": "both" } }) },
    });
    const doc = new Doc({ type: "root", extensions: [{ nodes: [Commented] }] });
    const node = doc.createNode(Commented);
    doc.root.append(node);
    const text = node.state.t;
    text.insert(0, "abcd");
    text.format(1, 3, "comment:1", true);
    text.insert(2, "x");
    text.insert(4, "y");
    expect(text.spans()).toStrictEqual([
      { text: "a", attrs: {} },
      { text: "bxc", attrs: { "comment:1": true } },
      { text: "yd", attrs: {} },
    ]);
  });

  test("typing at the edge of a link stays out of it, inside it stays in", () => {
    const { doc, nodes } = paragraphs(["see here."]);
    const text = nodes[0]!.state.t;
    text.format(4, 8, "link", "https://x");
    doc.forceCommit();
    text.insert(8, "!", {});
    text.insert(6, "-", { link: "https://x" });
    text.insert(4, "?", {});
    expect(text.spans()).toStrictEqual([
      { text: "see ?", attrs: {} },
      { text: "he-re", attrs: { link: "https://x" } },
      { text: "!.", attrs: {} },
    ]);
  });

  test("unbolding a letter keeps the letters typed after it bold", () => {
    const doc = new Doc(config(true));
    const node = doc.createNode(Paragraph);
    const text = node.state.t;
    checkTextUndo(doc, [
      () => {
        doc.root.append(node);
        text.insert(0, "a", { bold: true });
      },
      () => text.insert(1, "bcd", { bold: true }),
      () => text.format(0, 1, "bold", null),
    ]);
    expect(text.spans()).toStrictEqual([
      { text: "a", attrs: {} },
      { text: "bcd", attrs: { bold: true } },
    ]);
  });

  test("a pin right after the range says only its length; others say where", () => {
    const cluster = orderedCluster(["abcdef"], 2);
    const id = cluster.ids[0]!;
    // "cdef" inherits from "b": bolding "ab" pins it, from right after "b".
    const [after] = cluster.edit(0, () =>
      cluster.node(0, id).state.t.format(0, 2, "bold", true),
    );
    expect(JSON.stringify(after!.operations)).toMatch(/,true,\[0,4\]\]$/);
    // "x" typed after "e" inherits from it, but its ids are not after "e".
    cluster.edit(0, () => {
      cluster.node(0, id).state.t.insert(5, "x");
      cluster.node(0, id).state.t.format(2, 5, "italic", true);
    });
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.spans(1, id)).toStrictEqual([
      { text: "ab", attrs: { bold: true } },
      { text: "cde", attrs: { italic: true } },
      { text: "xf", attrs: {} },
    ]);
  });

  test("what a peer types after a letter follows it, even if bolded concurrently", () => {
    const cluster = orderedCluster(["ab"], 2);
    const id = cluster.ids[0]!;
    cluster.edit(0, () =>
      cluster.node(0, id).state.t.format(0, 2, "bold", true),
    );
    cluster.edit(1, () => cluster.node(1, id).state.t.insert(2, "c"));
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.spans(0, id)).toStrictEqual([
      { text: "abc", attrs: { bold: true } },
    ]);
    expect(cluster.spans(1, id)).toStrictEqual(cluster.spans(0, id));
  });

  test("a letter keeps inheriting from a deleted one, also after a reload", () => {
    const { doc, nodes } = paragraphs(["ab"]);
    const text = nodes[0]!.state.t;
    text.format(0, 2, "bold", true);
    text.insert(2, "c", { bold: true });
    text.delete(1, 1);
    doc.forceCommit();
    const copy = reload(doc);
    const node = copy.root.first;
    if (!node?.is(Paragraph)) throw new Error("Expected the paragraph");
    expect(node.state.t.spans()).toStrictEqual([
      { text: "ac", attrs: { bold: true } },
    ]);
    expect(copy.root.toJSON()).toStrictEqual(doc.root.toJSON());
  });

  test("a text without rules inherits nothing", () => {
    const Plain = defineNode({ type: "plain", state: { t: defineText() } });
    const plainConfig = { type: "root", extensions: [{ nodes: [Plain] }] };
    const doc = new Doc(plainConfig);
    const node = doc.createNode(Plain);
    doc.root.append(node);
    doc.forceCommit();
    const peer = Doc.fromJSON(
      { ...plainConfig, id: doc.root.id },
      doc.toJSON(),
    );
    peer.forceCommit();
    const [batch] = sent(doc, () => {
      node.state.t.insert(0, "ab", { bold: true, italic: null });
      node.state.t.insert(2, "c");
    });
    peer.applyOperations(batch!);
    peer.forceCommit();
    const expected = [
      { text: "ab", attrs: { bold: true } },
      { text: "c", attrs: {} },
    ];
    expect(node.state.t.spans()).toStrictEqual(expected);
    const copy = peer.getNodeById(node.id);
    if (!copy?.is(Plain)) throw new Error("Expected the node");
    expect(copy.state.t.spans()).toStrictEqual(expected);
  });

  test("the letters that inherited from a range keep each what they had", () => {
    const Colored = defineNode({
      type: "colored",
      state: { t: defineText({ inherit: { color: "origin" } }) },
    });
    const doc = new Doc({ type: "root", extensions: [{ nodes: [Colored] }] });
    const node = doc.createNode(Colored);
    doc.root.append(node);
    const text = node.state.t;
    // "b" inherits red from "a", "d" blue from "c"; "b" is then deleted.
    text.insert(0, "a", { color: "red" });
    text.insert(1, "b");
    text.insert(2, "c", { color: "blue" });
    text.insert(3, "d");
    text.delete(1, 1);
    text.format(0, 2, "color", "green");
    expect(text.spans()).toStrictEqual([
      { text: "ac", attrs: { color: "green" } },
      { text: "d", attrs: { color: "blue" } },
    ]);
  });

  test("the key of delete is not written as a state", () => {
    const { nodes } = paragraphs(["ab"]);
    const text = nodes[0]!.state.t;
    expect(() => text.format(0, 1, "~d", true)).toThrow("use delete()");
    expect(() => text.insert(0, "x", { "~d": true })).toThrow("use delete()");
  });

  test("a deleted paragraph letter stays opaque after a reload, for a few bytes", () => {
    const deleteAll = (text: string) => {
      const { doc, nodes } = paragraphs([""]);
      const t = nodes[0]!.state.t;
      t.insert(0, "x".repeat(200), { bold: true });
      t.insert(200, text, {});
      t.delete(0, t.length);
      t.insert(0, "y");
      doc.forceCommit();
      // Saved again before any reading of it, its letters stay as loaded.
      expect(reload(reload(doc)).root.toJSON()).toStrictEqual(
        doc.root.toJSON(),
      );
      const copy = reload(doc);
      const node = copy.root.first;
      if (!node?.is(Paragraph)) throw new Error("Expected the paragraph");
      expect(node.state.t.spans()).toStrictEqual(t.spans());
      expect(copy.root.toJSON()).toStrictEqual(doc.root.toJSON());
      return JSON.stringify(doc.root.toJSON()).length;
    };
    // "z" after the paragraph letter inherits nothing, deleted or not.
    // What it costs does not grow with the letters deleted around it.
    const long = "a".repeat(300);
    expect(deleteAll(`${long}\x7fz`) - deleteAll(`${long}bz`)).toBeLessThan(8);
  });

  test("a key without a rule is not inherited", () => {
    const { nodes } = paragraphs(["ab"]);
    const text = nodes[0]!.state.t;
    text.format(0, 2, "color", "red");
    text.insert(2, "c");
    expect(text.spans()).toStrictEqual([
      { text: "ab", attrs: { color: "red" } },
      { text: "c", attrs: {} },
    ]);
  });
});

describe("delete is a state", () => {
  test("a delete costs as much after formats, a lamport more after an undo of one", () => {
    const { doc, nodes } = paragraphs(["Hello world"], true);
    const text = nodes[0]!.state.t;
    const plain = sent(doc, () => text.delete(0, 1));
    text.format(0, 2, "color", "red");
    doc.forceCommit();
    const formatted = sent(doc, () => text.delete(0, 1));
    doc.undoManager.undo();
    doc.forceCommit();
    const undone = sent(doc, () => text.delete(0, 1));
    expect(JSON.stringify(plain[0]![1])).toBe("-1");
    expect(bytes(formatted)).toBe(bytes(plain));
    expect(JSON.stringify(undone[0]!.slice(1))).toMatch(/^\[-1,.*,1\]$/);
  });

  test("an undo of a delete brings the same letters back, with their state", () => {
    const doc = new Doc(config(true));
    const node = doc.createNode(Paragraph);
    const text = node.state.t;
    checkTextUndo(doc, [
      () => {
        doc.root.append(node);
        text.insert(0, "Hello world");
      },
      () => text.format(0, 5, "color", "red"),
      () => text.delete(2, 6),
    ]);
    doc.undoManager.undo();
    doc.forceCommit();
    expect(text.spans()).toStrictEqual([
      { text: "Hello", attrs: { color: "red" } },
      { text: " world", attrs: {} },
    ]);
    // No new letters: the same runs, the tombstones gone.
    expect(runsOf(doc)[0]!.join("")).toBe("Hello world");
  });

  test("an undo after a reload brings back letters the stored text left out", () => {
    const { doc, nodes } = paragraphs(["Hello brave world"], true);
    nodes[0]!.state.t.delete(5, 6);
    doc.forceCommit();
    const copy = Doc.fromJSON(
      { ...config(true), id: doc.root.id },
      doc.toJSON(),
    );
    copy.forceCommit();
    copy.undoManager.importHistory(doc.undoManager.exportHistory());
    const peer = Doc.fromJSON(
      { ...config(true), id: doc.root.id },
      doc.toJSON(),
    );
    peer.forceCommit();
    const [undo] = sent(copy, () => copy.undoManager.undo());
    peer.applyOperations(undo!);
    peer.forceCommit();
    for (const each of [copy, peer]) {
      const node = each.root.first;
      if (!node?.is(Paragraph)) throw new Error("Expected the paragraph");
      expect(node.state.t.get()).toBe("Hello brave world");
    }
  });

  test("an undo of a delete brings back what a peer deleted concurrently", () => {
    const cluster = orderedCluster(["abcd"], 2, true);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.delete(1, 2));
    cluster.edit(1, () => cluster.node(1, id).state.t.delete(1, 1));
    cluster.deliverAll();
    // The undo is newer than both deletes, as Yjs's new copy would be.
    cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("abcd");
  });
});

describe("pins and texts without rules", () => {
  test("pins of two values: what letters inherited, and that they had none", () => {
    const { doc, nodes } = paragraphs([""]);
    const text = nodes[0]!.state.t;
    text.insert(0, "a", { bold: true });
    text.insert(1, "f");
    text.insert(1, "r", {});
    text.insert(2, "g");
    doc.forceCommit();
    // "f" inherits from "a"; "g", from "r", which says it has none.
    text.format(0, 2, "bold", "x");
    doc.forceCommit();
    expect(text.spans()).toStrictEqual([
      { text: "ar", attrs: { bold: "x" } },
      { text: "g", attrs: {} },
      { text: "f", attrs: { bold: true } },
    ]);
  });

  test("a text without rules has only what was written on each letter", () => {
    const Plain = defineNode({ type: "plain", state: { t: defineText() } });
    const plainConfig = () => ({
      type: "root",
      extensions: [{ nodes: [Plain] }],
      crdt: labelsEngine(),
    });
    const doc = new Doc(plainConfig());
    const node = doc.createNode(Plain);
    doc.root.append(node);
    node.state.t.insert(0, "ab", { link: { url: "x" }, bold: null });
    node.state.t.insert(2, "c");
    doc.forceCommit();
    const spans = [
      { text: "ab", attrs: { link: { url: "x" } } },
      { text: "c", attrs: {} },
    ];
    expect(node.state.t.spans()).toStrictEqual(spans);
    const copy = Doc.fromJSON(
      { ...plainConfig(), id: doc.root.id },
      doc.toJSON(),
    );
    const loaded = copy.getNodeById(node.id);
    expect(loaded?.is(Plain) && loaded.state.t.spans()).toStrictEqual(spans);
  });
});
