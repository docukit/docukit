import { test, expect } from "@playwright/test";
import {
  assertDoc,
  createDocNode,
  deleteDocNode,
  DocNodeHelper,
  initTest,
  openDoc,
} from "./utils.js";

test.describe("main", () => {
  test("initial state new", async ({ page, context }) => {
    const dn = await DocNodeHelper.create({ page, context });

    await dn.createChild({ parent: "root", panel: "main" });

    const pages = await initTest(page, context);
    await expect(pages[0].getByText("root -")).toHaveCount(2);
    await expect(pages[1].getByText("root -")).toHaveCount(2);
    await assertDoc(pages, ["1", "2", "__2.1", "__2.2", "3", "4"]);
  });

  test("initial state", async ({ page, context }) => {
    const pages = await initTest(page, context);
    await expect(pages[0].getByText("root -")).toHaveCount(2);
    await expect(pages[1].getByText("root -")).toHaveCount(2);
    await assertDoc(pages, ["1", "2", "__2.1", "__2.2", "3", "4"]);
  });

  test("sync same tab", async ({ page, context }) => {
    const pages = await initTest(page, context);
    await createDocNode(pages, "root");
    await createDocNode(pages, "root");
    await createDocNode(pages, "1");
    await createDocNode(pages, "1");
    await createDocNode(pages, "2");
    await assertDoc(pages, [
      "1",
      "__1.1",
      "__1.2",
      "2",
      "__2.1",
      "__2.2",
      "__2.3",
      "3",
      "4",
      "5",
      "6",
    ]);
    await deleteDocNode(pages, "2");
    await deleteDocNode(pages, "4");
    await assertDoc(pages, ["1", "__1.1", "__1.2", "3", "5", "6"]);
    await openDoc(pages[0], "1");
    await assertDoc(pages[0], []);
    await createDocNode(pages, "1", "secondary");
    await assertDoc(pages[0], ["1"]);
    await pages[0].reload();
    await openDoc(pages[0], "root");
    await assertDoc(pages, ["1", "__1.1", "__1.2", "3", "5", "6"]);
    await assertDoc(pages[0], ["1"]);
    await openDoc(pages[1], "1");
    await assertDoc(pages[1], []);
    await openDoc(pages[1], "root");
    await assertDoc(pages[1], ["1"]);
  });
});
