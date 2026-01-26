import { test } from "@playwright/test";
import { EditorHelper } from "./utils.js";

test("editor", async ({ page }) => {
  const dn = await EditorHelper.create({ page });
  await dn.reference.select(0, 3);
  await page.keyboard.type(" Hello");
  await dn.assertContent(["One Hello", "Two", "Three"]);
});
