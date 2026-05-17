import type { SelectionExpectation } from "../utils.js";

export type ExpectedSelection =
  | { kind: "selectedText"; text: string }
  | { kind: "selectedReplacementOrCursor"; textBeforeCursor: string }
  | { kind: "collapsedAfter"; textBeforeCursor: string };

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
  return { kind: "collapsed", offset: range.end };
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
