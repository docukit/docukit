import {
  expect,
  type BrowserContext,
  type Page,
  type Locator,
} from "@playwright/test";

export class DocNodeHelper {
  private _page1: Page;
  private _page2: Page;

  private _app1: Locator;
  private _app2: Locator;
  private _app3: Locator;
  private _app4: Locator;
  private _currentApp: Locator;

  getDocnodes(panel: "main" | "secondary") {
    return this._currentApp.locator(`.${panel}-doc .docnode`);
  }

  private constructor(page1: Page, page2: Page) {
    this._page1 = page1;
    this._page2 = page2;

    this._app1 = page1.locator("#original");
    this._app2 = page1.locator("#copy");
    this._app3 = page2.locator("#original");
    this._app4 = page2.locator("#copy");

    this._currentApp = process.env.DN_APP ? this._app1 : this._app3;
    console.log(`Using app ${process.env.DN_APP ? "one" : "three"}`);
  }

  static async create({
    page,
    context,
  }: {
    page: Page;
    context: BrowserContext;
  }) {
    const page2 = await context.newPage();

    await page.goto("");
    await page2.goto("");

    const helper = new DocNodeHelper(page, page2);
    return helper;
  }

  private async _assertSync() {
    expect(await this._app1.innerHTML()).toEqual(await this._app2.innerHTML());
    expect(await this._app1.innerHTML()).toEqual(await this._app3.innerHTML());
    expect(await this._app1.innerHTML()).toEqual(await this._app4.innerHTML());
  }

  async assertPanel(panel: "main" | "secondary", state: string[]) {
    await this._assertSync();
    state.unshift("root");
    const docNodes = this.getDocnodes(panel).locator("span");
    const count = await docNodes.count();
    for (let i = 0; i < count; i++) {
      const text = await docNodes.nth(i).textContent();
      if (!text) {
        throw new Error("Text is null");
      }
      const textBeforeDash = text.split("-")[0]?.trim();
      if (i === 0) expect(textBeforeDash).toBe("root");
      else expect(textBeforeDash).toBe(state[i]?.replace(/__/g, ""));

      const rect = await docNodes
        .nth(i)
        .evaluate((el) => el.getBoundingClientRect());
      const indent = i === 0 ? 0 : (state[i]?.match(/__/g)?.length ?? 0) + 1;
      expect(rect.left).toBe(indent * 40);
    }
    await this._assertSync();
  }

  async createChild({
    parent,
    panel,
  }: {
    parent: string;
    panel: "main" | "secondary";
  }) {
    await this._assertSync();
    const docnodes = this.getDocnodes(panel);
    const countBefore = await docnodes.count();
    const createButton = this._currentApp
      .locator(`.${panel}-doc .docnode`)
      .filter({ hasText: new RegExp(`^${parent} - `) })
      .locator("button.create");
    await createButton.click();
    const countAfter = await docnodes.count();
    expect(countAfter).toBe(countBefore + 1);
    await this._assertSync();
  }

  async delete({ node, panel }: { node: string; panel: "main" | "secondary" }) {
    await this._assertSync();
    const deleteButton = this._currentApp
      .locator(`.${panel}-doc .docnode`)
      .filter({ hasText: new RegExp(`^${node} - `) })
      .locator("button.delete");
    await deleteButton.click();
    await this._assertSync();
  }
}
