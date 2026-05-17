import {
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { ulid } from "ulid";
import { HelperBase } from "../utils.js";

export type SelectionExpectation =
  | { kind: "range"; text: string; anchorOffset: number; focusOffset: number }
  | { kind: "collapsed"; offset: number }
  | { kind: "none" };

export const INITIAL_BLOCKS = ["Item one.", "Item two.", "Item three."];
export const THIRD_PARAGRAPH = 2;
export const ORIGINAL_REFERENCE_SELECTION: SelectionExpectation = {
  kind: "range",
  text: "em th",
  anchorOffset: 2,
  focusOffset: 7,
};

type SelectionInfo = {
  text: string;
  anchorOffset: number;
  focusOffset: number;
  isCollapsed: boolean;
};

type ClientUtils = {
  select: (block: number, offset: number) => Promise<void>;
  selectRange: (block: number, start: number, end: number) => Promise<void>;
  type: (text: string) => Promise<void>;
  press: (key: string) => Promise<void>;
  pressAndAssertSelectionUnchanged: (key: string) => Promise<void>;
  assertSelection: (selection: SelectionExpectation) => Promise<void>;
  assertRemoteSelection: (
    userName: string,
    selection: SelectionExpectation,
  ) => Promise<void>;
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
    const helper = new this(page, ulid().toLowerCase());
    await page.goto(`editor?docId=${helper.docId}`);
    await page.waitForLoadState("networkidle");
    await page.locator("#reference").first().waitFor({ state: "visible" });
    return helper;
  }

  static async open<T extends EditorHelper>(
    this: new (page: Page, docId: string) => T,
    { page, docId }: { page: Page; docId: string },
  ): Promise<T> {
    const helper = new this(page, docId);
    await helper._gotoEditor();
    return helper;
  }

  private _createClientUtils(clientLocator: Locator): ClientUtils {
    return {
      select: async (block: number, offset: number) => {
        await this._selectRange(clientLocator, block, offset, offset);
      },
      selectRange: async (block: number, start: number, end: number) => {
        await this._selectRange(clientLocator, block, start, end);
      },
      type: async (text: string) => {
        await this._page.bringToFront();
        await this._page.keyboard.insertText(text);
        await this._page.waitForTimeout(10);
      },
      press: async (key: string) => {
        await this._page.bringToFront();
        await this._page.keyboard.press(key);
        await this._page.waitForTimeout(10);
      },
      pressAndAssertSelectionUnchanged: async (key: string) => {
        await this._page.bringToFront();
        await clientLocator.evaluate((element) => {
          if (element instanceof HTMLElement) element.focus();
        });
        const selectionBefore = await this._readSelection(clientLocator);
        await this._page.keyboard.press(key);
        await this._page.waitForTimeout(10);
        await expect
          .poll(() => this._readSelection(clientLocator), { timeout: 1_000 })
          .toStrictEqual(selectionBefore);
      },
      assertSelection: async (selection: SelectionExpectation) => {
        await expect
          .poll(() => this._readSelection(clientLocator), { timeout: 1_000 })
          .toStrictEqual(this._selectionInfo(selection));
      },
      assertRemoteSelection: async (
        userName: string,
        selection: SelectionExpectation,
      ) => {
        await expect
          .poll(() => this._readRemoteSelection(clientLocator, userName), {
            timeout: 1_000,
          })
          .toStrictEqual(this._selectionInfo(selection));
      },
    };
  }

  private async _gotoEditor() {
    await this._page.goto(`editor?docId=${this.docId}`);
    await this._page.waitForLoadState("networkidle");
    await this._page
      .locator("#reference")
      .first()
      .waitFor({ state: "visible" });
  }

  private async _selectRange(
    clientLocator: Locator,
    block: number,
    start: number,
    end: number,
  ) {
    await this._page.bringToFront();
    await clientLocator.click();
    for (let i = 0; i < 3; i++) {
      await this._page.keyboard.press("ControlOrMeta+ArrowUp");
    }
    for (let i = 0; i < block; i++) {
      await this._page.keyboard.press("ArrowDown");
    }
    for (let i = 0; i < start; i++) {
      await this._page.keyboard.press("ArrowRight");
    }
    for (let i = start; i < end; i++) {
      await this._page.keyboard.press("Shift+ArrowRight");
    }
    await this._page.waitForTimeout(10);
  }

  private async _readSelection(
    clientLocator: Locator,
  ): Promise<SelectionInfo | undefined> {
    return clientLocator.evaluate((element) => {
      const selection = window.getSelection();
      if (
        !selection ||
        selection.rangeCount === 0 ||
        !selection.anchorNode ||
        !selection.focusNode ||
        !element.contains(selection.anchorNode) ||
        !element.contains(selection.focusNode)
      ) {
        return undefined;
      }

      return {
        text: selection.toString(),
        anchorOffset: selection.anchorOffset,
        focusOffset: selection.focusOffset,
        isCollapsed: selection.isCollapsed,
      };
    });
  }

  private async _readRemoteSelection(
    clientLocator: Locator,
    userName: string,
  ): Promise<SelectionInfo | undefined> {
    return clientLocator.evaluate((element, expectedUserName) => {
      function getOffsetFromPoint(
        paragraph: HTMLParagraphElement,
        x: number,
        y: number,
      ): number | undefined {
        const doc = document as Document & {
          caretRangeFromPoint?: (x: number, y: number) => Range | undefined;
        };

        const position = doc.caretPositionFromPoint?.(x, y);
        if (position) {
          return getOffsetInParagraph(
            paragraph,
            position.offsetNode,
            position.offset,
          );
        }

        const range = doc.caretRangeFromPoint?.(x, y);
        if (!range) return undefined;
        return getOffsetInParagraph(
          paragraph,
          range.startContainer,
          range.startOffset,
        );
      }

      function getOffsetInParagraph(
        paragraph: HTMLParagraphElement,
        node: Node,
        offset: number,
      ): number | undefined {
        if (!paragraph.contains(node)) return undefined;

        const range = document.createRange();
        range.selectNodeContents(paragraph);
        range.setEnd(node, offset);
        return range.toString().length;
      }

      const editor = element.querySelector("[data-lexical-editor]");
      if (!(editor instanceof HTMLElement)) return undefined;

      const overlay = Array.from(editor.parentElement?.children ?? []).find(
        (child) =>
          child !== editor &&
          child instanceof HTMLDivElement &&
          child.style.pointerEvents === "none",
      );
      if (!(overlay instanceof HTMLDivElement)) return undefined;

      const selectionElement = Array.from(overlay.children).find(
        (child) =>
          child instanceof HTMLSpanElement &&
          child.textContent?.includes(expectedUserName),
      );
      if (!(selectionElement instanceof HTMLSpanElement)) return undefined;

      const paragraphs = editor.querySelectorAll("p");
      const paragraph = paragraphs[THIRD_PARAGRAPH];
      if (!(paragraph instanceof HTMLParagraphElement)) return undefined;

      const rect = selectionElement.getBoundingClientRect();
      const middleY = rect.top + rect.height / 2;
      const startX = rect.width > 2 ? rect.left + 1 : rect.left;
      const endX = rect.width > 2 ? rect.right - 1 : rect.right;

      const startOffset = getOffsetFromPoint(paragraph, startX, middleY);
      const endOffset = getOffsetFromPoint(paragraph, endX, middleY);
      if (startOffset === undefined || endOffset === undefined)
        return undefined;

      const anchorOffset = Math.min(startOffset, endOffset);
      const focusOffset = Math.max(startOffset, endOffset);
      const text = paragraph.textContent ?? "";

      return {
        text: text.slice(anchorOffset, focusOffset),
        anchorOffset,
        focusOffset,
        isCollapsed: anchorOffset === focusOffset,
      };
    }, userName);
  }

  private _selectionInfo(
    selection: SelectionExpectation,
  ): SelectionInfo | undefined {
    if (selection.kind === "none") return undefined;
    if (selection.kind === "collapsed") {
      return {
        text: "",
        anchorOffset: selection.offset,
        focusOffset: selection.offset,
        isCollapsed: true,
      };
    }
    return {
      text: selection.text,
      anchorOffset: selection.anchorOffset,
      focusOffset: selection.focusOffset,
      isCollapsed: false,
    };
  }

  async assertContent(blocks: string[]) {
    await expect(this._reference.locator("[data-lexical-editor] p")).toHaveText(
      blocks,
      { timeout: 1_000 },
    );
    await expect(this._otherTab.locator("[data-lexical-editor] p")).toHaveText(
      blocks,
      { timeout: 1_000 },
    );
    await expect(
      this._otherDevice.locator("[data-lexical-editor] p"),
    ).toHaveText(blocks, { timeout: 1_000 });
  }
}

export async function createEditorPair(page: Page, context: BrowserContext) {
  const reference = await EditorHelper.create({ page });
  const remotePage = await context.newPage();
  const remote = await EditorHelper.open({
    page: remotePage,
    docId: reference.docId,
  });

  await reference.assertContent(INITIAL_BLOCKS);
  await remote.assertContent(INITIAL_BLOCKS);

  return { reference, remote };
}

export function collapsed(offset: number): SelectionExpectation {
  return { kind: "collapsed", offset };
}
