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
        console.log(
          "[EditorHelper.select] start block=%s offset=%s",
          block,
          offset,
        );
        await clientLocator.click();
        await this._page.keyboard.press("ControlOrMeta+ArrowUp");
        for (let i = 0; i < block; i++) {
          await this._page.keyboard.press("ArrowDown");
          const blockText = await this._reference
            .locator("[data-lexical-editor] p")
            .nth(i + 1)
            .textContent()
            .catch(() => null);
          console.log(
            "[EditorHelper.select] ArrowDown step %s -> block %s, paragraph text: %s",
            i + 1,
            i + 1,
            JSON.stringify(blockText),
          );
        }
        for (let i = 0; i < offset; i++) {
          await this._page.keyboard.press("ArrowRight");
          const charAtCaret = await this._page.evaluate(() => {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) return null;
            const range = sel.getRangeAt(0);
            const node = range.startContainer;
            const off = range.startOffset;
            if (node.nodeType === Node.TEXT_NODE && node.textContent)
              return node.textContent[off] ?? null;
            return null;
          });
          console.log(
            "[EditorHelper.select] ArrowRight step %s -> offset %s, char at caret: %s",
            i + 1,
            i + 1,
            JSON.stringify(charAtCaret),
          );
        }
        // Allow selection to settle before typing (CI is slower than local)
        await this._page.waitForTimeout(150);
        console.log("[EditorHelper.select] done (after 150ms settle)");
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

    console.log(
      "[EditorHelper.assertContent] expected:",
      JSON.stringify(blocks),
    );
    console.log(
      "[EditorHelper.assertContent] reference:",
      JSON.stringify(referenceContent),
    );
    console.log(
      "[EditorHelper.assertContent] otherTab:",
      JSON.stringify(otherTabContent),
    );
    console.log(
      "[EditorHelper.assertContent] otherDevice:",
      JSON.stringify(otherDeviceContent),
    );

    expect(referenceContent).toStrictEqual(blocks);
    expect(otherTabContent).toStrictEqual(blocks);
    expect(otherDeviceContent).toStrictEqual(blocks);
  }
}
