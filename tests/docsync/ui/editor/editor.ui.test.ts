import { test } from "@playwright/test";
import { EditorHelper } from "./utils.js";

test("editor", async ({ page }) => {
  const dn = await EditorHelper.create({ page });
  await dn.reference.select(0, 3);
  await page.keyboard.type(" Hello");
  await dn.assertContent(["One Hello", "Two", "Three"]);
});

// Regression: HistoryPlugin's undo went through setEditorState(), which left
// child dirtyElements empty and caused syncLexicalToDocNode to skip the
// propagation. Routing undo through DocNode's UndoManager bypasses that path.
test("undo through Cmd/Ctrl+Z restores all synced panels in lock-step", async ({
  page,
}) => {
  const dn = await EditorHelper.create({ page });
  await dn.reference.select(0, 3);
  await page.keyboard.type("X");
  await dn.assertContent(["OneX", "Two", "Three"]);

  await page.keyboard.press("ControlOrMeta+z");
  await dn.assertContent(["One", "Two", "Three"]);
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
  await dn.reference.select(0, 3);
  await page.keyboard.type("X");
  await dn.assertContent(["OneX", "Two", "Three"]);

  await page.keyboard.press("ControlOrMeta+z");
  await dn.assertContent(["One", "Two", "Three"]);

  // Typing immediately after undo should land at the pre-edit position
  // (offset 3 in "One"), producing "OneY" — not "YOne" or "OYne", which
  // would indicate the cursor jumped to start/middle.
  await page.keyboard.type("Y");
  await dn.assertContent(["OneY", "Two", "Three"]);

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
  await dn.reference.select(0, 3);
  await page.keyboard.type("X");
  await dn.assertContent(["OneX", "Two", "Three"]);

  await page.keyboard.press("ControlOrMeta+z");
  await dn.assertContent(["One", "Two", "Three"]);

  await page.keyboard.press("ControlOrMeta+Shift+z");
  await dn.assertContent(["OneX", "Two", "Three"]);

  // Cursor should be at offset 4 (end of "OneX"), so typing "Y" produces
  // "OneXY". If redo restored to the pre-edit position (offset 3), we'd get
  // "OneYX" — that's the regression we're guarding against.
  await page.keyboard.type("Y");
  await dn.assertContent(["OneXY", "Two", "Three"]);
});

// TODO: selection should not jump to the start when switching clients
