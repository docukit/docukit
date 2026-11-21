import { Doc, type Operations } from "@docukit/docnode";
import { describe, expect, test } from "vitest";

import {
  backspaceJoin,
  checkTextUndo,
  config,
  orderedCluster,
  Paragraph,
  paragraphs,
} from "./utils.js";

const stored = (doc: Doc) => JSON.stringify(doc.root.toJSON());

describe("undo of a delete, with no delete ids in the document", () => {
  test("typing, deleting, formatting and their undos and redos", () => {
    const doc = new Doc(config(true));
    const node = doc.createNode(Paragraph);
    const text = node.state.t;
    checkTextUndo(doc, [
      () => {
        doc.root.append(node);
        text.insert(0, "Hello brave world");
      },
      () => text.delete(5, 6),
      () => text.format(0, 5, "bold", true),
      () => text.delete(0, 2),
    ]);
  });

  test("the stored text keeps no trace of which delete removed what", () => {
    const { doc, nodes } = paragraphs(["0123456789".repeat(20)]);
    // Forward deletes, one letter each: 200 deletes, one tombstone run.
    for (let count = 0; count < 200; count++) {
      nodes[0]!.state.t.delete(0, 1);
      doc.forceCommit();
    }
    expect(stored(doc).length).toBeLessThan(150);
  });

  test("two peers delete the same letters: their undos bring back one copy", () => {
    const cluster = orderedCluster(["abcd"], 2, true);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.delete(1, 2));
    cluster.edit(1, () => cluster.node(1, id).state.t.delete(1, 2));
    cluster.deliverAll();
    // Like `@lexical/y`: even though peer 1 deleted them too.
    cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("abcd");
    // An undo brings the same letters back: there is only one copy.
    cluster.edit(1, (doc) => doc.undoManager.undo());
    cluster.deliverAll();
    expect(cluster.text(0, id)).toBe("abcd");
    // The last write wins: a redo deletes them again.
    cluster.edit(0, (doc) => doc.undoManager.redo());
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("ad");
  });

  test("concurrent undos of the same delete, in any order, converge", () => {
    const cluster = orderedCluster(["abcd"], 2, true);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.delete(1, 2));
    cluster.edit(1, () => cluster.node(1, id).state.t.delete(1, 2));
    cluster.deliverAll();
    cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.edit(1, (doc) => doc.undoManager.undo());
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("abcd");
  });

  test("undoing an insert a peer then deleted part of, and redoing it", () => {
    const cluster = orderedCluster(["ad"], 2, true);
    const id = cluster.ids[0]!;
    cluster.edit(0, () => cluster.node(0, id).state.t.insert(1, "bc"));
    cluster.deliverAll();
    cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.edit(1, () => cluster.node(1, id).state.t.delete(1, 1));
    cluster.deliverAll();
    // The redo brings back all of it, also what the peer deleted.
    cluster.edit(0, (doc) => doc.undoManager.redo());
    cluster.deliverAll();
    cluster.assertConverged();
    expect(cluster.text(0, id)).toBe("abcd");
  });

  test("an undo after a reload from the stored document brings the letters back", () => {
    const { doc, nodes } = paragraphs(["Hello brave world"], true);
    nodes[0]!.state.t.delete(5, 6);
    doc.forceCommit();
    expect(stored(doc)).not.toContain("brave");
    const copy = Doc.fromJSON(
      { ...config(true), id: doc.root.id },
      doc.toJSON(),
    );
    copy.forceCommit();
    copy.undoManager.importHistory(doc.undoManager.exportHistory());
    copy.undoManager.undo();
    copy.forceCommit();
    const node = copy.root.first;
    if (!node?.is(Paragraph)) throw new Error("Expected the paragraph");
    expect(node.state.t.get()).toBe("Hello brave world");
  });

  test("an undo of a join that arrives again changes nothing", () => {
    const cluster = orderedCluster(["hello", "world"], 2, true);
    const [hello, world] = cluster.ids as [string, string];
    cluster.edit(0, () =>
      backspaceJoin(cluster.node(0, hello), cluster.node(0, world)),
    );
    cluster.deliverAll();
    const [undo] = cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.deliverAll();
    cluster.docs[1]!.applyOperations(undo!.operations, { skipUndo: true });
    cluster.docs[1]!.forceCommit();
    cluster.assertConverged();
    expect(cluster.texts(1)).toStrictEqual(["hello", "world"]);
  });

  test("an undo of a join that arrives before the join waits for it", () => {
    const cluster = orderedCluster(["hello", "world"], 2, true);
    const [hello, world] = cluster.ids as [string, string];
    const [join] = cluster.edit(0, () =>
      backspaceJoin(cluster.node(0, hello), cluster.node(0, world)),
    );
    const [undo] = cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.deliver(undo!, 1);
    cluster.deliver(join!, 1);
    // The undone join never reads as joined: the undo, newer, keeps "world"
    // and the letters the join moved stay deleted.
    expect(cluster.texts(1)).toStrictEqual(["hello", "world"]);
  });

  test("an undone insert stays undone when its undo arrives again after a reload", () => {
    const { doc, nodes } = paragraphs(["ab"], true);
    nodes[0]!.state.t.insert(1, "XY");
    doc.forceCommit();
    const undos: Operations[] = [];
    doc.onChange(({ operations }) => undos.push(operations));
    doc.undoManager.undo();
    doc.forceCommit();
    const copy = Doc.fromJSON(
      { ...config(true), id: doc.root.id },
      doc.toJSON(),
    );
    copy.forceCommit();
    for (const operations of undos) copy.applyOperations(operations);
    copy.forceCommit();
    expect(stored(copy)).toBe(stored(doc));
    const node = copy.root.first;
    if (!node?.is(Paragraph)) throw new Error("Expected the paragraph");
    expect(node.state.t.get()).toBe("ab");
  });

  test("a delete or an undo that arrives again changes nothing", () => {
    const cluster = orderedCluster(["abcd"], 2, true);
    const id = cluster.ids[0]!;
    const [remove] = cluster.edit(0, () =>
      cluster.node(0, id).state.t.delete(1, 2),
    );
    const [undo] = cluster.edit(0, (doc) => doc.undoManager.undo());
    cluster.edit(1, () => cluster.node(1, id).state.t.delete(0, 1));
    cluster.deliverAll();
    // A client's pending operations, applied again on the server's state.
    for (const entry of [remove!, undo!])
      cluster.docs[1]!.applyOperations(entry.operations, { skipUndo: true });
    cluster.docs[1]!.forceCommit();
    expect(cluster.text(1, id)).toBe("bcd");
    const reloaded = Doc.fromJSON(
      { ...config(true), id: cluster.docs[1]!.root.id },
      cluster.docs[1]!.toJSON(),
    );
    reloaded.forceCommit();
    for (const entry of [remove!, undo!])
      reloaded.applyOperations(entry.operations, { skipUndo: true });
    reloaded.forceCommit();
    expect(stored(reloaded)).toBe(stored(cluster.docs[1]!));
  });
});
