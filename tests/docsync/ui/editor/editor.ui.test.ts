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

// TODO: selection should not jump to the start when switching clients
