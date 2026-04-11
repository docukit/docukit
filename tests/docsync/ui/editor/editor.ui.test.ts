import { test } from "@playwright/test";
import { EditorHelper } from "./utils.js";

const backends = [
  { name: "DocNode", path: "/editor-docnode" },
  { name: "Yjs", path: "/editor-yjs" },
];

for (const { name, path } of backends) {
  const createHelper = EditorHelper.createForRoute(path);

  test.describe(`Editor (${name})`, () => {
    test("editor", async ({ page }) => {
      const dn = await createHelper({ page });
      await dn.reference.select(0, 3);
      await page.keyboard.type(" Hello");
      await dn.assertContent(["One Hello", "Two", "Three"]);
    });
  });
}

// TODO: selection should not jump to the start when switching clients
