import { test } from "@playwright/test";
import { EditorHelper } from "./utils.js";

test("editor", async ({ page }) => {
  console.log("[editor.ui] create helper and load page");
  const dn = await EditorHelper.create({ page });
  console.log("[editor.ui] select(0, 3)");
  await dn.reference.select(0, 3);
  console.log("[editor.ui] type(' Hello')");
  await page.keyboard.type(" Hello");
  const expected = ["One Hello", "Two", "Three"];
  console.log("[editor.ui] assertContent expected:", JSON.stringify(expected));
  await dn.assertContent(expected);
});

// TODO: selection should not jump to the start when switching clients
