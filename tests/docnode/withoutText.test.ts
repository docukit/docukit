import { test, vi } from "vitest";
import { assertDoc, createTextDocWithUndo, text } from "./utils.js";

// This file never defines text nor merges batches, so its documents run
// without the text rows of the wire format (see `text/wire.ts`).

test("edits within mergeInterval are one undo step without text", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const doc = createTextDocWithUndo(10, 500);
    doc.root.append(...text(doc, "a"));
    doc.forceCommit();
    now.mockReturnValue(1400);
    doc.root.append(...text(doc, "b"));
    doc.forceCommit();

    doc.undoManager.undo();
    assertDoc(doc, []);
    doc.undoManager.redo();
    assertDoc(doc, ["a", "b"]);
  } finally {
    now.mockRestore();
  }
});
