import { describe, expect, test } from "vitest";
import { lexicalTestWrapper } from "./lexicalUtils.js";
import { LEXICAL_CRDT_DOC_TYPE, LEXICAL_DOC_TYPE } from "./utils.js";

/**
 * A device that edits offline and reconnects after another device edited
 * too puts the server's operations before its own. A doc that rebases in
 * place stays the same doc; one with a CRDT engine keeps nothing to undo, so
 * DocSync swaps the live doc for a rebuilt one and the editor is bound to it.
 */
describe.each([
  { name: "rebased", type: LEXICAL_DOC_TYPE, newDocs: 0 },
  { name: "replaced", type: LEXICAL_CRDT_DOC_TYPE, newDocs: 1 },
])("Lexical editor on a $name doc", ({ type, newDocs }) => {
  const reconnectAfterConcurrentEdits = (
    callback: Parameters<typeof lexicalTestWrapper>[0],
  ) =>
    lexicalTestWrapper(async (setup) => {
      const { reference, otherDevice } = setup;
      await reference.load(["Item one.", "Item two."]);
      await otherDevice.assertTexts(["Item one.", "Item two."]);

      reference.disconnect();
      reference.select({ block: 1, offset: 9 });
      reference.type("!");
      await reference.assertPendingEdits();
      reference.select({ block: 1, offset: 5 }, { block: 1, offset: 8 });

      otherDevice.select({ block: 0, offset: 0 });
      otherDevice.type("New ");
      await otherDevice.assertSynced();

      const docsBefore = reference.docs.length;
      reference.connect();
      await reference.assertTexts(["New Item one.", "Item two.!"]);
      await reference.assertSynced();
      expect(reference.docs.length).toBe(docsBefore + newDocs);
      await callback(setup);
    }, type);

  test("keeps the selection", async () => {
    await reconnectAfterConcurrentEdits(async ({ reference }) => {
      await reference.assertSelection(
        { block: 1, offset: 5 },
        { block: 1, offset: 8 },
      );
    });
  });

  test("keeps the undo history", async () => {
    await reconnectAfterConcurrentEdits(async ({ reference, otherDevice }) => {
      reference.undo();
      await reference.assertTexts(["New Item one.", "Item two."]);
      await reference.assertSelection({ block: 1, offset: 9 });
      await otherDevice.assertTexts(["New Item one.", "Item two."]);
    });
  });
});

describe("a remote caret through DocSync", () => {
  test("moves with its letters when the other device types before it", async () => {
    await lexicalTestWrapper(async ({ reference, otherDevice }) => {
      await reference.load(["hello", "world"]);
      await otherDevice.assertTexts(["hello", "world"]);
      reference.focus();
      reference.select({ block: 1, offset: 2 });
      await otherDevice.assertCaretOf(reference, ["hello", "wo|rld"]);

      otherDevice.select({ block: 1, offset: 0 });
      otherDevice.type("XY");
      await otherDevice.assertCaretOf(reference, ["hello", "XYwo|rld"]);
      await reference.assertTexts(["hello", "XYworld"]);
    });
  });
});
