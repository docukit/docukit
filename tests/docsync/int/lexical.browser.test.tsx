import { describe, expect, test } from "vitest";
import { lexicalTestWrapper } from "./lexicalUtils.js";

/**
 * A device that edits offline and reconnects after another device edited
 * too gets a rebuilt document: DocSync puts the server's operations before
 * its own and swaps the live doc. The editor is then bound to the new doc.
 */
describe("Lexical editor on a replaced doc", () => {
  const swapAfterConcurrentEdits = (
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
      expect(reference.docs.length).toBeGreaterThan(docsBefore);
      await callback(setup);
    });

  test("keeps the selection", async () => {
    await swapAfterConcurrentEdits(async ({ reference }) => {
      await reference.assertSelection(
        { block: 1, offset: 5 },
        { block: 1, offset: 8 },
      );
    });
  });

  test("keeps the undo history", async () => {
    await swapAfterConcurrentEdits(async ({ reference, otherDevice }) => {
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
