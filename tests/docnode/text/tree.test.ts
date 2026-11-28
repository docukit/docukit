import { Doc } from "@docukit/docnode";
import { describe, expect, test } from "vitest";
import { checkUndoManager } from "../utils.js";
import {
  bodies,
  config,
  docWithParagraph,
  first,
  orderedServer,
  paragraph,
  randomEdits,
  textDoc,
} from "./utils.js";

// A text keeps its runs in a B-tree (`textTree.ts`). Thousands of edits at
// random places leave thousands of runs: leaves and inner nodes split, and
// some leaves are left empty.
describe("a text of many runs", () => {
  test("edits at random places give the right text, and undo and redo them", () => {
    const doc = textDoc();
    let expected = "";
    checkUndoManager(1, doc, () => {
      expected = randomEdits(paragraph(doc).state.body, 3000);
    });
    expect(bodies(doc)).toStrictEqual([expected]);
  });

  test("a replica applies the edits another made at random places", () => {
    const { replica, edit } = orderedServer((doc) => paragraph(doc, "seed"));
    const [docA, docB] = [replica(), replica()];
    const batches = edit(docA, (doc) =>
      randomEdits(first(doc).state.body, 3000),
    );
    for (const batch of batches) docB.applyOperations(batch);
    docB.forceCommit();
    expect(bodies(docB)).toStrictEqual(bodies(docA));
  });

  test("a stored text of many runs loads, and edits of it stay right", () => {
    const { doc, body } = docWithParagraph();
    randomEdits(body, 2000);
    doc.forceCommit();
    const loaded = first(Doc.fromJSON(config, doc.toJSON())).state.body;
    expect(loaded.get()).toBe(body.get());
    const expected = randomEdits(body, 500, 2);
    expect(randomEdits(loaded, 500, 2)).toBe(expected);
    expect(loaded.get()).toBe(expected);
  });
});
