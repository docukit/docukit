import { expect, type Locator, type Page } from "@playwright/test";
import { HelperBase } from "../utils.js";

type ClientUtils = {
  select: (block: number, offset: number) => Promise<void>;
};

export class EditorHelper extends HelperBase {
  reference: ClientUtils;
  otherTab: ClientUtils;
  otherDevice: ClientUtils;

  constructor(page: Page, docId: string) {
    super(page, docId);
    this.reference = this._createClientUtils(this._reference);
    this.otherTab = this._createClientUtils(this._otherTab);
    this.otherDevice = this._createClientUtils(this._otherDevice);
  }

  static override async create<T extends HelperBase>(
    this: new (page: Page, docId: string) => T,
    { page }: { page: Page },
  ): Promise<T> {
    const helper = await super.create({ page });
    await page.goto(`editor?docId=${helper.docId}`);
    await page.waitForLoadState("networkidle");
    await page.locator("#reference").first().waitFor({ state: "visible" });
    return helper as T;
  }

  private _createClientUtils(clientLocator: Locator): ClientUtils {
    return {
      select: async (block: number, offset: number) => {
        await clientLocator.click();
        // Move to start of document: in CI focus may land in the last paragraph,
        // so press ArrowUp multiple times to reach the first block.
        for (let i = 0; i < 3; i++) {
          await this._page.keyboard.press("ControlOrMeta+ArrowUp");
        }
        for (let i = 0; i < block; i++) {
          await this._page.keyboard.press("ArrowDown");
        }
        for (let i = 0; i < offset; i++) {
          await this._page.keyboard.press("ArrowRight");
        }
      },
    };
  }

  async assertContent(blocks: string[]) {
    const referenceContent = await this._reference
      .locator("[data-lexical-editor] p")
      .allTextContents();
    const otherTabContent = await this._otherTab
      .locator("[data-lexical-editor] p")
      .allTextContents();
    const otherDeviceContent = await this._otherDevice
      .locator("[data-lexical-editor] p")
      .allTextContents();

    expect(referenceContent).toStrictEqual(blocks);
    expect(otherTabContent).toStrictEqual(blocks);
    expect(otherDeviceContent).toStrictEqual(blocks);
  }
}
