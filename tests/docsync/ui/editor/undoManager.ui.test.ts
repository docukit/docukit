import { test } from "@playwright/test";

import {
  collapsed,
  INITIAL_BLOCKS,
  ORIGINAL_REFERENCE_SELECTION,
  THIRD_PARAGRAPH,
  createEditorPair,
  EditorHelper,
} from "./utils.js";

test("undo should restore the local selection", async ({ page }) => {
  const dn = await EditorHelper.create({ page });

  await dn.reference.selectRange(THIRD_PARAGRAPH, 2, 7);
  await dn.reference.type("x");
  await dn.assertContent(["Item one.", "Item two.", "Itxree."]);
  await dn.reference.assertSelection(collapsed(3));

  await dn.reference.press("ControlOrMeta+z");
  await dn.assertContent(INITIAL_BLOCKS);
  await dn.reference.assertSelection(ORIGINAL_REFERENCE_SELECTION);

  await dn.reference.type("x");
  await dn.assertContent(["Item one.", "Item two.", "Itxree."]);
  await dn.reference.assertSelection(collapsed(3));
});

test("immediate undo and redo should keep the correct local selections", async ({
  page,
}) => {
  const dn = await EditorHelper.create({ page });

  await dn.reference.selectRange(THIRD_PARAGRAPH, 2, 7);

  // No helper here: we want undo to happen immediately after typing, before
  // any extra wait that could hide a pending-transaction race.
  // This case also explains why UndoManager events expose `type`: the binding
  // needs to avoid attaching a pending selection to the wrong undo/redo push.
  await page.keyboard.insertText("x");
  await page.keyboard.press("ControlOrMeta+z");

  await dn.assertContent(INITIAL_BLOCKS);
  await dn.reference.assertSelection(ORIGINAL_REFERENCE_SELECTION);

  await page.keyboard.press("ControlOrMeta+Shift+z");
  await dn.assertContent(["Item one.", "Item two.", "Itxree."]);
  await dn.reference.assertSelection(collapsed(3));
});

test("should not undo remote operations", async ({ page, context }) => {
  const { reference, remote } = await createEditorPair(page, context);
  const expectedBlocks = ["Item one.", "Item two.", "Itxree."];

  await remote.otherDevice.selectRange(THIRD_PARAGRAPH, 2, 7);
  await remote.otherDevice.type("x");
  await reference.assertContent(expectedBlocks);
  await remote.assertContent(expectedBlocks);

  await reference.reference.pressAndAssertSelectionUnchanged("ControlOrMeta+z");
  await reference.assertContent(expectedBlocks);
  await remote.assertContent(expectedBlocks);

  // Just in case, test that local undo works on the originating device
  await remote.otherDevice.press("ControlOrMeta+z");
  await reference.assertContent(INITIAL_BLOCKS);
  await remote.assertContent(INITIAL_BLOCKS);
  await remote.otherDevice.assertSelection(ORIGINAL_REFERENCE_SELECTION);
});
