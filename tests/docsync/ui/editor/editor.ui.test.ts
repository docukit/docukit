import { test } from "@playwright/test";
import { EditorHelper } from "./utils.js";

test("editor", async ({ page }) => {
  const dn = await EditorHelper.create({ page });
  await dn.reference.select(0, 9);
  await page.keyboard.type(" Hello");
  await dn.assertContent(["Item one. Hello", "Item two.", "Item three."]);
});

// Regression: HistoryPlugin's undo went through setEditorState(), which left
// child dirtyElements empty and caused syncLexicalToDocNode to skip the
// propagation. Routing undo through DocNode's UndoManager bypasses that path.
test("undo through Cmd/Ctrl+Z restores all synced panels in lock-step", async ({
  page,
}) => {
  const dn = await EditorHelper.create({ page });
  await dn.reference.select(0, 9);
  await page.keyboard.type("X");
  await dn.assertContent(["Item one.X", "Item two.", "Item three."]);

  await page.keyboard.press("ControlOrMeta+z");
  await dn.assertContent(["Item one.", "Item two.", "Item three."]);
});

// Regression: pre-undo cursor jumped to the start of the block (and Lexical
// logged `IndexSizeError: offset N is larger than node's length`) because the
// UndoManager only restored content, not selection. Fix: syncUndoManager
// captures the pre-edit selection on push and restores it on pop.
test("undo restores the cursor to the pre-edit position (no IndexSizeError)", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const dn = await EditorHelper.create({ page });
  await dn.reference.select(0, 9);
  await page.keyboard.type("X");
  await dn.assertContent(["Item one.X", "Item two.", "Item three."]);

  await page.keyboard.press("ControlOrMeta+z");
  await dn.assertContent(["Item one.", "Item two.", "Item three."]);

  // Typing immediately after undo should land at the pre-edit position
  // (offset 9 in "Item one."), producing "Item one.Y" — not a mid-string
  // insertion, which would indicate the cursor jumped unexpectedly.
  await page.keyboard.type("Y");
  await dn.assertContent(["Item one.Y", "Item two.", "Item three."]);

  // The IndexSizeError that motivated this regression test must not appear.
  const indexSizeErrors = consoleErrors.filter((e) =>
    e.includes("IndexSizeError"),
  );
  if (indexSizeErrors.length > 0) {
    throw new Error(
      `Expected no IndexSizeError in console, got:\n${indexSizeErrors.join("\n")}`,
    );
  }
});

// Mirror of the undo selection regression test: redo should land the cursor
// at the post-edit position (i.e. where the user was right before pressing
// undo). Without REDO_COMMAND capturing that selection, redoing reverts the
// content but leaves the caret at the pre-edit offset.
test("redo restores the post-undo cursor (so subsequent typing extends the redone text)", async ({
  page,
}) => {
  const dn = await EditorHelper.create({ page });
  await dn.reference.select(0, 9);
  await page.keyboard.type("X");
  await dn.assertContent(["Item one.X", "Item two.", "Item three."]);

  await page.keyboard.press("ControlOrMeta+z");
  await dn.assertContent(["Item one.", "Item two.", "Item three."]);

  await page.keyboard.press("ControlOrMeta+Shift+z");
  await dn.assertContent(["Item one.X", "Item two.", "Item three."]);

  // Cursor should be at offset 10 (end of "Item one.X"), so typing "Y"
  // produces "Item one.XY". If redo restored to the pre-edit position
  // (offset 9), we'd get "Item one.YX" instead.
  await page.keyboard.type("Y");
  await dn.assertContent(["Item one.XY", "Item two.", "Item three."]);
});

// TODO: selection should not jump to the start when switching clients
