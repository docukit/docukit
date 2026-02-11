import { expect, type Locator, type Page } from "@playwright/test";
import { ulid } from "ulid";

export class HelperBase {
  protected _page: Page;

  // clients
  protected _reference: Locator;
  protected _otherTab: Locator;
  protected _otherDevice: Locator;

  // Hidden duplicates (same client, multiple useDoc calls)
  protected _referenceHidden: Locator;
  protected _otherTabHidden: Locator;
  protected _otherDeviceHidden: Locator;

  docId: string;

  async navigateToNewDoc() {
    const oldDocId = this.docId;
    // Click on the subdocs link in the sidebar
    await this._page.locator("a[href='/subdocs']").click();

    // Wait for the URL to change and get the new docId in one go
    const docId = await this._page
      .waitForFunction(
        (expectedOldDocId) => {
          const params = new URLSearchParams(window.location.search);
          const currentDocId = params.get("docId");
          return currentDocId && currentDocId !== expectedOldDocId
            ? currentDocId
            : false;
        },
        oldDocId,
        { timeout: 2000 },
      )
      .then((handle) => handle.jsonValue() as Promise<string>);

    await this._page.waitForLoadState("networkidle");
    expect(docId).not.toBe(oldDocId);
    this.docId = docId;
  }

  protected constructor(page: Page, docId: string) {
    this._page = page;
    this.docId = docId;

    // Page 1: reference, otherTab, otherDevice
    this._reference = page.locator("#reference").first();
    this._otherTab = page.locator("#otherTab").first();
    this._otherDevice = page.locator("#otherDevice").first();

    // Hidden duplicates (testing multiple useDoc for same document)
    this._referenceHidden = page.locator("#reference-hidden").first();
    this._otherTabHidden = page.locator("#otherTab-hidden").first();
    this._otherDeviceHidden = page.locator("#otherDevice-hidden").first();
  }

  static async create<T extends HelperBase>(
    this: new (page: Page, docId: string) => T,
    { page }: { page: Page },
  ): Promise<T> {
    const docId = ulid().toLowerCase();
    const helper = new this(page, docId);
    return helper;
  }
}
