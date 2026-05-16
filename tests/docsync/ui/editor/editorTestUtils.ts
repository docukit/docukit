import type { BrowserContext, Page } from "@playwright/test";

import { EditorHelper, type SelectionExpectation } from "./utils.js";

export const INITIAL_BLOCKS = ["Item one.", "Item two.", "Item three."];
export const THIRD_PARAGRAPH = 2;
export const INITIAL_TEXT = INITIAL_BLOCKS[THIRD_PARAGRAPH]!;
export const ORIGINAL_REFERENCE_SELECTION = range("em th", 2, 7);

export type ExpectedSelection =
  | { kind: "selectedText"; text: string }
  | { kind: "selectedReplacementOrCursor"; textBeforeCursor: string }
  | { kind: "collapsedAfter"; textBeforeCursor: string };

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

export function range(
  text: string,
  anchorOffset: number,
  focusOffset: number,
): SelectionExpectation {
  return { kind: "range", text, anchorOffset, focusOffset };
}

export function collapsed(offset: number): SelectionExpectation {
  return { kind: "collapsed", offset };
}

export function selectedText(text: string): ExpectedSelection {
  return { kind: "selectedText", text };
}

export function selectedReplacementOrCursorAfter(
  textBeforeCursor: string,
): ExpectedSelection {
  return { kind: "selectedReplacementOrCursor", textBeforeCursor };
}

export function collapsedAfter(textBeforeCursor: string): ExpectedSelection {
  return { kind: "collapsedAfter", textBeforeCursor };
}

export function expectedSelection(
  currentText: string,
  expected: ExpectedSelection,
  replacement?: string,
): SelectionExpectation {
  if (expected.kind === "collapsedAfter") {
    return cursorAfter(currentText, expected.textBeforeCursor);
  }

  if (expected.kind === "selectedReplacementOrCursor") {
    if (replacement == null) {
      return cursorAfter(currentText, expected.textBeforeCursor);
    }
    return rangeForUniqueSubstring(currentText, replacement);
  }

  return rangeForUniqueSubstring(
    currentText,
    expected.text.replaceAll("{replacement}", replacement ?? ""),
  );
}

export function uniqueRangeForSubstring(text: string, substring: string) {
  const start = text.indexOf(substring);
  if (start === -1) {
    throw new Error(`Expected "${text}" to contain "${substring}".`);
  }

  const nextStart = text.indexOf(substring, start + 1);
  if (nextStart !== -1) {
    throw new Error(
      `Expected "${substring}" to appear once in "${text}", but it appears more than once.`,
    );
  }

  return { start, end: start + substring.length };
}

export function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function cursorAfter(
  currentText: string,
  textBeforeCursor: string,
): SelectionExpectation {
  const range = uniqueRangeForSubstring(currentText, textBeforeCursor);
  return collapsed(range.end);
}

function rangeForUniqueSubstring(
  currentText: string,
  selectedSubstring: string,
): SelectionExpectation {
  const range = uniqueRangeForSubstring(currentText, selectedSubstring);
  return {
    kind: "range",
    text: selectedSubstring,
    anchorOffset: range.start,
    focusOffset: range.end,
  };
}
