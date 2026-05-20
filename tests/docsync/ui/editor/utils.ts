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

export type BlockPoint = { block: number; offset: number };

export type CrossBlockSelectionExpectation =
  | { kind: "range"; text?: string; anchor: BlockPoint; focus: BlockPoint }
  | { kind: "collapsed"; point: BlockPoint }
  | { kind: "none" };

export const INITIAL_BLOCKS = ["Item one.", "Item two.", "Item three."];
export const SECOND_PARAGRAPH = 1;
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

type CrossBlockSelectionInfo = {
  text?: string;
  anchor: BlockPoint;
  focus: BlockPoint;
  isCollapsed: boolean;
};

type ClientUtils = {
  select: (block: number, offset: number) => Promise<void>;
  selectRange: (block: number, start: number, end: number) => Promise<void>;
  selectRangeAcrossBlocks: (
    start: BlockPoint,
    end: BlockPoint,
  ) => Promise<void>;
  formatBold: () => Promise<void>;
  type: (text: string) => Promise<void>;
  press: (key: string) => Promise<void>;
  pressAndAssertSelectionUnchanged: (key: string) => Promise<void>;
  assertSelection: (selection: SelectionExpectation) => Promise<void>;
  assertSelectionAcrossBlocks: (
    selection: CrossBlockSelectionExpectation,
  ) => Promise<void>;
  assertBoldText: (block: number, text: string) => Promise<void>;
  assertRemoteSelection: (
    userName: string,
    selection: SelectionExpectation,
  ) => Promise<void>;
  assertRemoteSelectionAcrossBlocks: (
    userName: string,
    selection: CrossBlockSelectionExpectation,
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
    await page.goto(`editor?docId=${helper.docId}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForEditorReady(page);
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
      selectRangeAcrossBlocks: async (start: BlockPoint, end: BlockPoint) => {
        await this._selectRangeAcrossBlocks(clientLocator, start, end);
      },
      formatBold: async () => {
        await this._page.bringToFront();
        await this._page.keyboard.press("ControlOrMeta+B");
        await this._page.waitForTimeout(10);
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
      assertSelectionAcrossBlocks: async (
        selection: CrossBlockSelectionExpectation,
      ) => {
        const expected = this._crossBlockSelectionInfo(selection);
        if (!expected) {
          await expect
            .poll(() => this._readSelectionAcrossBlocks(clientLocator), {
              timeout: 1_000,
            })
            .toBeUndefined();
          return;
        }

        await expect
          .poll(() => this._readSelectionAcrossBlocks(clientLocator), {
            timeout: 1_000,
          })
          .toMatchObject(expected);
      },
      assertBoldText: async (block: number, text: string) => {
        await expect
          .poll(() => this._hasBoldText(clientLocator, block, text), {
            timeout: 1_000,
          })
          .toBe(true);
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
      assertRemoteSelectionAcrossBlocks: async (
        userName: string,
        selection: CrossBlockSelectionExpectation,
      ) => {
        const expected = this._crossBlockSelectionInfo(selection);
        if (!expected) {
          await expect
            .poll(
              () =>
                this._readRemoteSelectionAcrossBlocks(clientLocator, userName),
              { timeout: 1_000 },
            )
            .toBeUndefined();
          return;
        }

        await expect
          .poll(
            () =>
              this._readRemoteSelectionAcrossBlocks(clientLocator, userName),
            { timeout: 1_000 },
          )
          .toMatchObject(expected);
      },
    };
  }

  private async _gotoEditor() {
    await this._page.goto(`editor?docId=${this.docId}`, {
      waitUntil: "domcontentloaded",
    });
    await waitForEditorReady(this._page);
  }

  private async _selectRange(
    clientLocator: Locator,
    block: number,
    start: number,
    end: number,
  ) {
    await this._page.bringToFront();
    await this._setSelectionAcrossBlocks(
      clientLocator,
      { block, offset: start },
      { block, offset: end },
    );
    await this._page.waitForTimeout(10);
  }

  private async _selectRangeAcrossBlocks(
    clientLocator: Locator,
    start: BlockPoint,
    end: BlockPoint,
  ) {
    await this._page.bringToFront();
    await this._setSelectionAcrossBlocks(clientLocator, start, end);
    await this._page.waitForTimeout(10);
  }

  private async _setSelectionAcrossBlocks(
    clientLocator: Locator,
    start: BlockPoint,
    end: BlockPoint,
  ) {
    await clientLocator.evaluate(
      (element, args) => {
        function pointAtOffset(
          paragraph: HTMLParagraphElement,
          targetOffset: number,
        ): { node: Node; offset: number } {
          const walker = document.createTreeWalker(
            paragraph,
            NodeFilter.SHOW_TEXT,
          );
          let traversed = 0;
          let lastText: Text | undefined;

          for (
            let current = walker.nextNode();
            current;
            current = walker.nextNode()
          ) {
            if (!(current instanceof Text)) continue;
            const nextTraversed = traversed + current.data.length;
            if (targetOffset <= nextTraversed) {
              return { node: current, offset: targetOffset - traversed };
            }
            traversed = nextTraversed;
            lastText = current;
          }

          if (lastText) {
            return { node: lastText, offset: lastText.data.length };
          }

          return { node: paragraph, offset: 0 };
        }

        const editor = element.querySelector("[data-lexical-editor]");
        if (!(editor instanceof HTMLElement)) {
          throw new Error("Expected Lexical editor element");
        }

        const paragraphs = Array.from(editor.querySelectorAll("p"));
        const startParagraph = paragraphs[args.start.block];
        const endParagraph = paragraphs[args.end.block];
        if (
          !(startParagraph instanceof HTMLParagraphElement) ||
          !(endParagraph instanceof HTMLParagraphElement)
        ) {
          throw new Error("Expected paragraph elements");
        }

        const startPoint = pointAtOffset(startParagraph, args.start.offset);
        const endPoint = pointAtOffset(endParagraph, args.end.offset);
        const range = document.createRange();
        range.setStart(startPoint.node, startPoint.offset);
        range.setEnd(endPoint.node, endPoint.offset);

        const selection = window.getSelection();
        if (!selection) throw new Error("Expected window selection");
        selection.removeAllRanges();
        selection.addRange(range);
        editor.focus({ preventScroll: true });
        document.dispatchEvent(new Event("selectionchange"));
      },
      { start, end },
    );
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

  private async _readSelectionAcrossBlocks(
    clientLocator: Locator,
  ): Promise<CrossBlockSelectionInfo | undefined> {
    return clientLocator.evaluate((element) => {
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

      function getPoint(
        editorElement: Element,
        node: Node,
        offset: number,
      ): BlockPoint | undefined {
        const paragraphs = Array.from(editorElement.querySelectorAll("p"));

        for (const [block, paragraph] of paragraphs.entries()) {
          if (!(paragraph instanceof HTMLParagraphElement)) continue;
          const pointOffset = getOffsetInParagraph(paragraph, node, offset);
          if (pointOffset !== undefined) {
            return { block, offset: pointOffset };
          }
        }

        return undefined;
      }

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

      const anchor = getPoint(
        element,
        selection.anchorNode,
        selection.anchorOffset,
      );
      const focus = getPoint(
        element,
        selection.focusNode,
        selection.focusOffset,
      );
      if (!anchor || !focus) {
        return undefined;
      }

      return {
        text: selection.toString(),
        anchor,
        focus,
        isCollapsed: selection.isCollapsed,
      };
    });
  }

  private async _readRemoteSelection(
    clientLocator: Locator,
    userName: string,
  ): Promise<SelectionInfo | undefined> {
    return clientLocator.evaluate(
      (element, args) => {
        function getOffsetFromPoint(
          paragraph: HTMLParagraphElement,
          x: number,
          y: number,
        ): number | undefined {
          const position = document.caretPositionFromPoint(x, y);
          if (position) {
            return getOffsetInParagraph(
              paragraph,
              position.offsetNode,
              position.offset,
            );
          }

          const range = document.caretRangeFromPoint(x, y);
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
            child.textContent?.includes(args.userName),
        );
        if (!(selectionElement instanceof HTMLSpanElement)) return undefined;

        const paragraphs = editor.querySelectorAll("p");
        const paragraph = paragraphs[args.paragraphIndex];
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
      },
      { userName, paragraphIndex: THIRD_PARAGRAPH },
    );
  }

  private async _readRemoteSelectionAcrossBlocks(
    clientLocator: Locator,
    userName: string,
  ): Promise<CrossBlockSelectionInfo | undefined> {
    return clientLocator.evaluate(
      (element, args) => {
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

        function getPointFromNode(
          editorElement: Element,
          node: Node,
          offset: number,
        ): BlockPoint | undefined {
          const paragraphs = Array.from(editorElement.querySelectorAll("p"));

          for (const [block, paragraph] of paragraphs.entries()) {
            if (!(paragraph instanceof HTMLParagraphElement)) continue;
            const pointOffset = getOffsetInParagraph(paragraph, node, offset);
            if (pointOffset !== undefined) {
              return { block, offset: pointOffset };
            }
          }
        }

        function getPointFromCoordinates(
          editorElement: Element,
          x: number,
          y: number,
        ): BlockPoint | undefined {
          const position = document.caretPositionFromPoint(x, y);
          if (position) {
            return getPointFromNode(
              editorElement,
              position.offsetNode,
              position.offset,
            );
          }

          const range = document.caretRangeFromPoint(x, y);
          if (!range) return undefined;
          return getPointFromNode(
            editorElement,
            range.startContainer,
            range.startOffset,
          );
        }

        function comparePoints(left: BlockPoint, right: BlockPoint): number {
          if (left.block !== right.block) {
            return left.block - right.block;
          }
          return left.offset - right.offset;
        }

        function sortRange(start: BlockPoint, end: BlockPoint) {
          return comparePoints(start, end) <= 0
            ? { start, end }
            : { start: end, end: start };
        }

        function getTextAcrossBlocks(
          editorElement: Element,
          anchor: BlockPoint,
          focus: BlockPoint,
        ): string {
          const paragraphs = Array.from(editorElement.querySelectorAll("p"));
          const start = comparePoints(anchor, focus) <= 0 ? anchor : focus;
          const end = start === anchor ? focus : anchor;
          const parts: string[] = [];

          for (let block = start.block; block <= end.block; block++) {
            const paragraph = paragraphs[block];
            if (!(paragraph instanceof HTMLParagraphElement)) continue;
            const text = paragraph.textContent ?? "";

            if (block === start.block && block === end.block) {
              parts.push(text.slice(start.offset, end.offset));
            } else if (block === start.block) {
              parts.push(text.slice(start.offset));
            } else if (block === end.block) {
              parts.push(text.slice(0, end.offset));
            } else {
              parts.push(text);
            }
          }

          return parts.join("\n\n");
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

        const selectionElements: HTMLSpanElement[] = [];
        let hasUserName = false;

        for (const child of overlay.children) {
          if (!(child instanceof HTMLSpanElement)) continue;
          selectionElements.push(child);
          if (child.textContent?.includes(args.userName)) {
            hasUserName = true;
          }
        }

        if (!hasUserName) return undefined;

        const ranges: { start: BlockPoint; end: BlockPoint }[] = [];

        for (const selectionElement of selectionElements) {
          const rect = selectionElement.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;

          const middleY = rect.top + rect.height / 2;
          const startX = rect.width > 2 ? rect.left + 1 : rect.left;
          const endX = rect.width > 2 ? rect.right - 1 : rect.right;
          const start = getPointFromCoordinates(editor, startX, middleY);
          const end = getPointFromCoordinates(editor, endX, middleY);

          if (start && end) {
            ranges.push(sortRange(start, end));
          }
        }

        ranges.sort((left, right) => comparePoints(left.start, right.start));

        const first = ranges[0];
        const last = ranges[ranges.length - 1];
        if (!first || !last) return undefined;

        return {
          anchor: first.start,
          focus: last.end,
          isCollapsed: comparePoints(first.start, last.end) === 0,
          text: getTextAcrossBlocks(editor, first.start, last.end),
        };
      },
      { userName },
    );
  }

  private async _hasBoldText(
    clientLocator: Locator,
    block: number,
    text: string,
  ): Promise<boolean> {
    return clientLocator.evaluate(
      (element, args) => {
        function isBoldElement(element: HTMLElement): boolean {
          const fontWeight = getComputedStyle(element).fontWeight;
          return (
            element.tagName === "B" ||
            element.tagName === "STRONG" ||
            element.classList.contains("font-bold") ||
            fontWeight === "bold" ||
            Number(fontWeight) >= 600
          );
        }

        const editor = element.querySelector("[data-lexical-editor]");
        if (!(editor instanceof HTMLElement)) return false;

        const paragraph = editor.querySelectorAll("p")[args.block];
        if (!(paragraph instanceof HTMLParagraphElement)) return false;

        const walker = document.createTreeWalker(
          paragraph,
          NodeFilter.SHOW_TEXT,
        );

        for (
          let current = walker.nextNode();
          current;
          current = walker.nextNode()
        ) {
          if (!(current instanceof Text) || current.data !== args.text) {
            continue;
          }

          return current.parentElement
            ? isBoldElement(current.parentElement)
            : false;
        }

        return false;
      },
      { block, text },
    );
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

  private _crossBlockSelectionInfo(
    selection: CrossBlockSelectionExpectation,
  ): CrossBlockSelectionInfo | undefined {
    if (selection.kind === "none") return undefined;
    if (selection.kind === "collapsed") {
      return {
        text: "",
        anchor: selection.point,
        focus: selection.point,
        isCollapsed: true,
      };
    }

    return {
      anchor: selection.anchor,
      focus: selection.focus,
      isCollapsed: false,
      ...(selection.text !== undefined ? { text: selection.text } : {}),
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

async function waitForEditorReady(page: Page) {
  const reference = page.locator("#reference").first();
  await reference.waitFor({ state: "visible" });
  await reference
    .locator("[data-lexical-editor] p")
    .first()
    .waitFor({ state: "visible" });
}

export function collapsed(offset: number): SelectionExpectation {
  return { kind: "collapsed", offset };
}
