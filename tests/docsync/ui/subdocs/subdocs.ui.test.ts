import { test } from "@playwright/test";
import { SubdocsHelper } from "./utils.js";

const backends = [
  { name: "DocNode", path: "/subdocs-docnode" },
  { name: "Yjs", path: "/subdocs-yjs" },
];

for (const { name, path } of backends) {
  const createHelper = SubdocsHelper.createForRoute(path);

  test.describe(`Subdocs (${name})`, () => {
    test("two real tabs syncs", async ({ page, context }) => {
      const dn = await createHelper({ page });
      const page2 = await context.newPage();
      const dn2 = await createHelper({ page: page2 });
      await page2.goto(`${path.slice(1)}?docId=${dn.docId}`);
      await page2.waitForLoadState("networkidle");

      await dn.assertPanel("main", ["1", "2", "__2.1", "__2.2", "3", "4"]);
      await dn2.assertPanel("main", ["1", "2", "__2.1", "__2.2", "3", "4"]);

      await dn.reference.createChild({ parent: "root", panel: "main" });
      await dn.assertPanel("main", ["1", "2", "__2.1", "__2.2", "3", "4", "5"]);
      await dn2.assertPanel("main", [
        "1",
        "2",
        "__2.1",
        "__2.2",
        "3",
        "4",
        "5",
      ]);

      await dn.reference.delete({ node: "2", panel: "main" });
      await dn.assertPanel("main", ["1", "3", "4", "5"]);
      // eslint-disable-next-line playwright/no-wait-for-timeout
      await page2.waitForTimeout(60);
      await dn2.assertPanel("main", ["1", "3", "4", "5"]);
    });

    test("navigate to new doc", async ({ page }) => {
      const dn = await createHelper({ page });
      await dn.navigateToNewDoc();
      await dn.assertPanel("main", ["1", "2", "__2.1", "__2.2", "3", "4"]);
    });

    test("reference and otherDevice add nodes concurrently", async ({
      page,
    }) => {
      const dn = await createHelper({ page });
      await dn.reference.disconnect();
      await dn.otherTab.disconnect();
      await dn.otherDevice.disconnect();
      await dn.reference.createChild({ parent: "root", panel: "main" });
      await dn.otherDevice.createChild({ parent: "2", panel: "main" });
      await dn.otherDevice.connect();
      await dn.reference.connect();
      // eslint-disable-next-line playwright/no-wait-for-timeout
      await page.waitForTimeout(10);
      // prettier-ignore
      await dn.assertPanel("main", ["1", "2", "__2.1", "__2.2", "__2.3", "3", "4", "5"]);
    });
  });
}
