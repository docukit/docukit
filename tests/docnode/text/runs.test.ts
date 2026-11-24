import { defineNode, defineText, Doc, type Operations } from "@docukit/docnode";
import { labelsEngine } from "@docukit/docnode/crdt";
import { describe, expect, test } from "vitest";

import {
  checkTextUndo,
  config,
  orderedCluster,
  Paragraph,
  paragraphs,
  reload,
  runsOf,
} from "./utils.js";

/**
 * Runs cut apart that can be one again are joined at the end of each
 * transaction, as Yjs does: the list stays short, and it is stored as is.
 */
describe("runs are joined again", () => {
  test("an undo of a delete brings the same letters back", () => {
    const doc = new Doc(config(true));
    const node = doc.createNode(Paragraph);
    checkTextUndo(doc, [
      () => {
        doc.root.append(node);
        node.state.t.insert(0, "Hello world");
      },
      () => node.state.t.delete(3, 5),
    ]);
    expect(runsOf(doc)).toStrictEqual([["Hel", "-----", "rld"]]);
    doc.undoManager.undo();
    // They keep the stamp that brought them back: a run of their own.
    expect(runsOf(doc)).toStrictEqual([["Hel", "lo wo", "rld"]]);
    // What is stored is what is in memory, and loads back the same.
    const reloaded = reload(doc);
    expect(runsOf(reloaded)).toStrictEqual(runsOf(doc));
    expect(reloaded.root.toJSON()).toStrictEqual(doc.root.toJSON());
  });

  test("a peer joins them too, and both store the same", () => {
    const cluster = orderedCluster(["Hello world", "Bye"], 2, true);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.delete(3, 5));
    cluster.deliverAll();
    cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.deliverAll();
    cluster.assertConverged();
    const runs = [["Hel", "lo wo", "rld"], ["Bye"]];
    expect(cluster.docs.map(runsOf)).toStrictEqual([runs, runs]);
  });

  test("a run cut every 4096 letters is stored as one, and loads cut the same", () => {
    const { doc, nodes } = paragraphs(["x".repeat(9000)]);
    const text = nodes[0]!.state.t;
    text.format(0, 5000, "color", "red");
    text.delete(8000, 1000);
    doc.forceCommit();
    // Cut at 4096 and 8192, and where the format and the delete end.
    const cut = ["x".repeat(4096), "x".repeat(904), "x".repeat(3000)];
    const deleted = ["-".repeat(192), "-".repeat(808)];
    expect(runsOf(doc)).toStrictEqual([[...cut, ...deleted]]);
    const reloaded = reload(doc);
    expect(runsOf(reloaded)).toStrictEqual(runsOf(doc));
    expect(reloaded.root.toJSON()).toStrictEqual(doc.root.toJSON());
    // One run: its length once, no cut in the stored text.
    const shorter = paragraphs(["x".repeat(4000)]).doc;
    const stored = (each: Doc) => JSON.stringify(each.root.toJSON()).length;
    expect(stored(paragraphs(["x".repeat(5000)]).doc) - stored(shorter)).toBe(
      1000,
    );
  });

  test("letters deleted one by one, then the rest, end in one run", () => {
    // 600 runs: the index of a session's runs needs a second chunk, which
    // joining them empties.
    const { doc, nodes } = paragraphs(["ab".repeat(300)]);
    const text = nodes[0]!.state.t;
    for (let index = 0; index < 300; index++) {
      text.delete(index, 1);
      doc.forceCommit();
    }
    expect(text.get()).toBe("b".repeat(300));
    expect(runsOf(doc)[0]).toHaveLength(600);
    text.delete(0, 300);
    doc.forceCommit();
    expect(runsOf(doc)).toStrictEqual([["-".repeat(600)]]);
    expect(runsOf(reload(doc))).toStrictEqual(runsOf(doc));
  });

  test("letters typed right after a backspace go after what it deleted, unless they inherit", () => {
    const Plain = defineNode({ type: "plain", state: { t: defineText() } });
    const both = {
      type: "root",
      extensions: [{ nodes: [Plain, Paragraph] }],
      crdt: labelsEngine(),
    };
    const doc = new Doc(both);
    const plain = doc.createNode(Plain);
    const rich = doc.createNode(Paragraph);
    doc.root.append(plain, rich);
    const edit = (change: () => void) => {
      change();
      doc.forceCommit();
    };
    const backspaceAndType = (text: typeof plain.state.t) => {
      edit(() => text.insert(0, "abc"));
      edit(() => text.delete(1, 2));
      edit(() => text.insert(1, "de"));
    };
    backspaceAndType(plain.state.t);
    expect(runsOf(doc)[0]).toStrictEqual(["a", "--", "de"]);
    // As in Yjs: deleting the new letters too joins them, one run.
    edit(() => plain.state.t.delete(1, 2));
    expect(runsOf(doc)[0]).toStrictEqual(["a", "----"]);
    // Once letters are typed after them, they keep what is typed before.
    edit(() => plain.state.t.insert(1, "g"));
    edit(() => plain.state.t.insert(1, "f"));
    expect(runsOf(doc)[0]).toStrictEqual(["a", "f", "----", "g"]);
    // Letters that inherit go before: they would from a deleted one.
    backspaceAndType(rich.state.t);
    expect(runsOf(doc)[1]).toStrictEqual(["a", "de", "--"]);
    const reloaded = Doc.fromJSON({ ...both, id: doc.root.id }, doc.toJSON());
    expect(runsOf(reloaded)).toStrictEqual(runsOf(doc));
  });

  test("letters typed after a backspace stay before a letter of another session", () => {
    const Plain = defineNode({ type: "plain", state: { t: defineText() } });
    const config = {
      type: "root",
      extensions: [{ nodes: [Plain] }],
      crdt: labelsEngine(),
    };
    const a = new Doc(config);
    const node = a.createNode(Plain);
    a.root.append(node);
    node.state.t.insert(0, "abc");
    a.forceCommit();
    const b = Doc.fromJSON({ ...config, id: a.root.id }, a.toJSON());
    b.forceCommit();
    const sent: Operations[] = [];
    b.onChange((event) => sent.push(event.operations));
    const other = b.getNodeById(node.id);
    if (other?.is(Plain)) other.state.t.insert(3, "x");
    b.forceCommit();
    a.applyOperations(sent[0]!, { skipUndo: true });
    a.forceCommit();
    node.state.t.delete(2, 1);
    a.forceCommit();
    node.state.t.insert(2, "d");
    a.forceCommit();
    // After the deleted letter, the new one would need the other session's
    // id as its right origin: more bytes on every update that types on.
    expect(runsOf(a)).toStrictEqual([["ab", "d", "-", "x"]]);
  });
});
