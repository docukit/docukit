import { test } from "@playwright/test";
import { DocNodeHelper } from "./utils.js";

test.describe("main", () => {
  // TODO: I should test with process.env.DN_APP too (see utils.ts)
  test("create and delete nodes", async ({ page, context }) => {
    const dn = await DocNodeHelper.create({ page, context });
    await dn.assertPanel("main", ["1", "2", "__2.1", "__2.2", "3", "4"]);
    await dn.createChild({ parent: "root", panel: "main" });
    await dn.assertPanel("main", ["1", "2", "__2.1", "__2.2", "3", "4", "5"]);
    await dn.createChild({ parent: "2.1", panel: "main" });
    // prettier-ignore
    await dn.assertPanel("main", ["1", "2", "__2.1", "____2.1.1", "__2.2", "3", "4", "5"]);
    await dn.delete({ node: "2", panel: "main" });
    await dn.assertPanel("main", ["1", "3", "4", "5"]);
  });
});
