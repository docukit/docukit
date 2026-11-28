import { describe, expect, test } from "vitest";
import { checkUndoManager } from "../utils.js";
import {
  Paragraph,
  bodies,
  docWithParagraph,
  first,
  paragraph,
  textDoc,
} from "./utils.js";

describe("undo of texts", () => {
  test("inserts, deletes and sets are undone and redone", () => {
    const doc = textDoc();
    checkUndoManager(5, doc, () => {
      const body = paragraph(doc).state.body;
      doc.forceCommit();
      body.insert(0, "Hola mundo");
      doc.forceCommit();
      body.delete(4, 6);
      doc.forceCommit();
      body.set((prev) => `${prev}!`);
      doc.forceCommit();
      body.set("¡Hello!");
    });
  });

  test("a delete of several runs puts each back with its ids", () => {
    const doc = textDoc();
    checkUndoManager(5, doc, () => {
      const body = paragraph(doc, "ac").state.body;
      doc.forceCommit();
      body.insert(1, "b");
      doc.forceCommit();
      body.insert(3, "d");
      doc.forceCommit();
      body.delete(0, 4);
      doc.forceCommit();
      body.insert(0, "x");
    });
  });

  test("letters made one after the other are put back in one insert", () => {
    const doc = textDoc();
    checkUndoManager(4, doc, () => {
      const body = paragraph(doc, "ab").state.body;
      doc.forceCommit();
      body.insert(1, "X");
      doc.forceCommit();
      body.delete(1, 1);
      doc.forceCommit();
      body.delete(0, 2);
    });
  });

  test("a node deleted in the transaction that inserted its parent needs no inverse", () => {
    const doc = textDoc();
    checkUndoManager(1, doc, () => {
      const parent = paragraph(doc, "a");
      const child = doc.createNode(Paragraph);
      child.state.body.insert(0, "child");
      parent.append(child);
      child.delete();
    });
  });

  test("a delete in the middle of the text is undone between its neighbours", () => {
    const doc = textDoc();
    checkUndoManager(3, doc, () => {
      const body = paragraph(doc, "abcdef").state.body;
      doc.forceCommit();
      body.insert(3, "XY");
      doc.forceCommit();
      body.delete(2, 3);
    });
  });

  test("a deleted node with text comes back with its text", () => {
    const doc = textDoc();
    checkUndoManager(3, doc, () => {
      const node = paragraph(doc, "ab");
      const child = doc.createNode(Paragraph);
      child.state.body.insert(0, "child");
      node.append(child);
      doc.forceCommit();
      node.state.body.insert(1, "X");
      doc.forceCommit();
      node.delete();
    });
  });

  test("text edits of a node inserted in the same transaction need no inverse", () => {
    const doc = textDoc();
    checkUndoManager(2, doc, () => {
      const node = paragraph(doc, "abc");
      node.state.body.delete(1, 1);
      node.state.body.insert(2, "d");
      doc.forceCommit();
      paragraph(doc, "x").state.body.set("y");
    });
  });

  test("typing and deleting merged in one step are undone together", () => {
    const { doc, body } = docWithParagraph(60_000);
    for (const edit of [
      () => body.insert(0, "a"),
      () => body.insert(1, "b"),
      () => body.insert(2, "c"),
      () => body.delete(2, 1),
      () => body.insert(0, "x"),
    ]) {
      edit();
      doc.forceCommit();
    }
    expect(bodies(doc)).toStrictEqual(["xab"]);
    // The history keeps the steps as batches.
    doc.undoManager.importHistory(doc.undoManager.exportHistory());
    while (doc.undoManager.canUndo()) doc.undoManager.undo();
    expect(bodies(doc)).toStrictEqual([""]);
    while (doc.undoManager.canRedo()) doc.undoManager.redo();
    expect(bodies(doc)).toStrictEqual(["xab"]);
    expect(first(doc).state.body.length).toBe(3);
  });
});
