import { test } from "@playwright/test";
import { DocNodeHelper } from "./utils.js";

test.describe("main", () => {
  test("two real tabs syncs", async ({ page, context }) => {
    const dn = await DocNodeHelper.create({ page });
    const page2 = await context.newPage();
    const dn2 = await DocNodeHelper.create({ page: page2 });
    await page2.goto(`subdocs?docId=${dn.docId}`);
    await page2.waitForLoadState("networkidle");

    await dn.assertPanel("main", ["1", "2", "__2.1", "__2.2", "3", "4"]);
    await dn2.assertPanel("main", ["1", "2", "__2.1", "__2.2", "3", "4"]);

    await dn.reference.createChild({ parent: "root", panel: "main" });
    await dn.assertPanel("main", ["1", "2", "__2.1", "__2.2", "3", "4", "5"]);
    await dn2.assertPanel("main", ["1", "2", "__2.1", "__2.2", "3", "4", "5"]);

    await dn.reference.delete({ node: "2", panel: "main" });
    await dn.assertPanel("main", ["1", "3", "4", "5"]);
    // eslint-disable-next-line playwright/no-wait-for-timeout
    await page2.waitForTimeout(60);
    await dn2.assertPanel("main", ["1", "3", "4", "5"]);
  });

  test("navigate to new doc", async ({ page }) => {
    const dn = await DocNodeHelper.create({ page });
    await dn.navigateToNewDoc();
    await dn.assertPanel("main", ["1", "2", "__2.1", "__2.2", "3", "4"]);
  });

  test("reference and otherDevice add nodes concurrently", async ({ page }) => {
    const dn = await DocNodeHelper.create({ page });
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

// TODO:
// "add child -> load"
// "load -> add child"
// "add child -> connect"
// "both devices add child -> connect"
// "both tabs add child -> connect"
// "reference and otherTab should sync event offline"
// "subdoc tests (secondary panel)"
