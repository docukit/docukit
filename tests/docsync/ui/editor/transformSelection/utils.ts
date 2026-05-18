import {
  type BlockPoint,
  type CrossBlockSelectionExpectation,
  INITIAL_BLOCKS,
  THIRD_PARAGRAPH,
  type SelectionExpectation,
} from "../utils.js";

export const INITIAL_TEXT = INITIAL_BLOCKS[THIRD_PARAGRAPH]!;
export const BLOCK_SEPARATOR = "\n\n";
export const FLAT_INITIAL_TEXT = INITIAL_BLOCKS.join(BLOCK_SEPARATOR);
export { INITIAL_BLOCKS };

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

export function globalOffsetToPoint(
  blocks: string[],
  targetOffset: number,
): BlockPoint {
  let traversed = 0;

  for (const [block, text] of blocks.entries()) {
    const blockEnd = traversed + text.length;
    if (targetOffset <= blockEnd) {
      return { block, offset: targetOffset - traversed };
    }
    traversed = blockEnd + BLOCK_SEPARATOR.length;
  }

  throw new Error(`Offset ${targetOffset} is outside the provided blocks.`);
}

export function replaceRangeAcrossBlocks(
  blocks: string[],
  start: BlockPoint,
  end: BlockPoint,
  replacement: string,
): string[] {
  if (start.block === end.block) {
    return blocks.map((text, block) =>
      block === start.block
        ? replaceRange(text, start.offset, end.offset, replacement)
        : text,
    );
  }

  const prefix = blocks[start.block]!.slice(0, start.offset);
  const suffix = blocks[end.block]!.slice(end.offset);
  const nextBlocks = blocks.slice();
  nextBlocks.splice(
    start.block,
    end.block - start.block + 1,
    `${prefix}${replacement}${suffix}`,
  );
  return nextBlocks;
}

export function expectedSelectionAcrossBlocks(
  currentBlocks: string[],
  expected: ExpectedSelection,
  replacement?: string,
  includeText = true,
): CrossBlockSelectionExpectation {
  const currentText = currentBlocks.join(BLOCK_SEPARATOR);

  if (expected.kind === "collapsedAfter") {
    const range = uniqueRangeForSubstring(
      currentText,
      expected.textBeforeCursor,
    );
    return {
      kind: "collapsed",
      point: globalOffsetToPoint(currentBlocks, range.end),
    };
  }

  if (expected.kind === "selectedReplacementOrCursor") {
    if (replacement == null) {
      const range = uniqueRangeForSubstring(
        currentText,
        expected.textBeforeCursor,
      );
      return {
        kind: "collapsed",
        point: globalOffsetToPoint(currentBlocks, range.end),
      };
    }
    const range = uniqueRangeForSubstring(currentText, replacement);
    return {
      kind: "range",
      ...(includeText ? { text: replacement } : {}),
      anchor: globalOffsetToPoint(currentBlocks, range.start),
      focus: globalOffsetToPoint(currentBlocks, range.end),
    };
  }

  const selectedSubstring = expected.text.replaceAll(
    "{replacement}",
    replacement ?? "",
  );
  const range = uniqueRangeForSubstring(currentText, selectedSubstring);
  return {
    kind: "range",
    ...(includeText ? { text: selectedSubstring } : {}),
    anchor: globalOffsetToPoint(currentBlocks, range.start),
    focus: globalOffsetToPoint(currentBlocks, range.end),
  };
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
