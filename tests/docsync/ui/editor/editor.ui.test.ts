import { test, type BrowserContext, type Page } from "@playwright/test";
import { EditorHelper, type SelectionExpectation } from "./utils.js";

const INITIAL_BLOCKS = ["Item one.", "Item two.", "Item three."];
const THIRD_PARAGRAPH = 2;
const INITIAL_TEXT = INITIAL_BLOCKS[THIRD_PARAGRAPH]!;
const ORIGINAL_REFERENCE_SELECTION = range("em th", 2, 7);

type RemoteCase = {
  description: string;
  remoteSubstring: string;
  referenceAfterEdit: ExpectedSelection;
};

type ExpectedSelection =
  | { kind: "selectedText"; text: string }
  | { kind: "selectedReplacementOrCursor"; textBeforeCursor: string }
  | { kind: "collapsedAfter"; textBeforeCursor: string };

type RemoteVariant = {
  action: string;
  replacement: (deletedLength: number) => string | undefined;
};

const remoteCases: RemoteCase[] = [
  {
    description: "the first part of the selection",
    remoteSubstring: "em",
    referenceAfterEdit: selectedText("{replacement} th"),
  },
  {
    description: "the last part of the selection",
    remoteSubstring: "th",
    referenceAfterEdit: selectedText("em {replacement}"),
  },
  {
    description: "the first part of the selection and one letter before",
    remoteSubstring: "tem",
    referenceAfterEdit: selectedText(" th"),
  },
  {
    description: "the last part of the selection and one letter after",
    remoteSubstring: "thr",
    referenceAfterEdit: selectedText("em "),
  },
  {
    description: "the exact selection",
    remoteSubstring: "em th",
    referenceAfterEdit: selectedReplacementOrCursorAfter("It"),
  },
  {
    description: "one letter before and after the selection",
    remoteSubstring: "tem thr",
    referenceAfterEdit: collapsedAfter("I"),
  },
];

const remoteVariants: RemoteVariant[] = [
  { action: "deletes", replacement: () => undefined },
  {
    action: "replaces with a shorter string",
    replacement: (deletedLength) => "x".repeat(deletedLength - 1),
  },
  {
    action: "replaces with a same-length string",
    replacement: (deletedLength) => "x".repeat(deletedLength),
  },
  {
    action: "replaces with a longer string",
    replacement: (deletedLength) => "x".repeat(deletedLength + 1),
  },
];

test("undo should restore the local selection", async ({ page }) => {
  const dn = await EditorHelper.create({ page });

  await dn.reference.selectRange(THIRD_PARAGRAPH, 2, 7);
  await dn.reference.type("x");
  await dn.assertContent(["Item one.", "Item two.", "Itxree."]);
  await dn.reference.assertSelection(collapsed(3));

  await dn.reference.press("ControlOrMeta+z");
  await dn.assertContent(INITIAL_BLOCKS);
  await dn.reference.assertSelection(ORIGINAL_REFERENCE_SELECTION);

  await dn.reference.type("x");
  await dn.assertContent(["Item one.", "Item two.", "Itxree."]);
  await dn.reference.assertSelection(collapsed(3));
});

test("should not undo remote operations, but should undo local operations on the originating device", async ({
  page,
  context,
}) => {
  const { reference, remote } = await createEditorPair(page, context);
  const expectedBlocks = ["Item one.", "Item two.", "Itxree."];

  await remote.otherDevice.selectRange(THIRD_PARAGRAPH, 2, 7);
  await remote.otherDevice.type("x");
  await reference.assertContent(expectedBlocks);
  await remote.assertContent(expectedBlocks);

  await reference.reference.pressAndAssertSelectionUnchanged("ControlOrMeta+z");
  await reference.assertContent(expectedBlocks);
  await remote.assertContent(expectedBlocks);

  await remote.otherDevice.press("ControlOrMeta+z");
  await reference.assertContent(INITIAL_BLOCKS);
  await remote.assertContent(INITIAL_BLOCKS);
  await remote.otherDevice.assertSelection(ORIGINAL_REFERENCE_SELECTION);
});

for (const remoteCase of remoteCases) {
  for (const variant of remoteVariants) {
    test(`remote user ${variant.action} ${remoteCase.description}`, async ({
      page,
      context,
    }) => {
      const remoteRange = uniqueRangeForSubstring(
        INITIAL_TEXT,
        remoteCase.remoteSubstring,
      );
      const deletedLength = remoteRange.end - remoteRange.start;
      const replacement = variant.replacement(deletedLength);
      const expectedAfterEdit = replaceRange(
        INITIAL_TEXT,
        remoteRange.start,
        remoteRange.end,
        replacement ?? "",
      );
      const expectedBlocks = ["Item one.", "Item two.", expectedAfterEdit];
      const { reference, remote } = await createEditorPair(page, context);

      await reference.reference.selectRange(THIRD_PARAGRAPH, 2, 7);
      await reference.reference.assertSelection(ORIGINAL_REFERENCE_SELECTION);

      await remote.otherDevice.selectRange(
        THIRD_PARAGRAPH,
        remoteRange.start,
        remoteRange.end,
      );
      if (replacement == null) {
        await remote.otherDevice.press("Backspace");
      } else {
        await remote.otherDevice.type(replacement);
      }

      await reference.assertContent(expectedBlocks);
      await remote.assertContent(expectedBlocks);
      await reference.reference.assertSelection(
        expectedSelection(
          expectedAfterEdit,
          remoteCase.referenceAfterEdit,
          replacement,
        ),
      );
    });
  }
}

async function createEditorPair(page: Page, context: BrowserContext) {
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

function range(
  text: string,
  anchorOffset: number,
  focusOffset: number,
): SelectionExpectation {
  return { kind: "range", text, anchorOffset, focusOffset };
}

function collapsed(offset: number): SelectionExpectation {
  return { kind: "collapsed", offset };
}

function selectedText(text: string): ExpectedSelection {
  return { kind: "selectedText", text };
}

function selectedReplacementOrCursorAfter(
  textBeforeCursor: string,
): ExpectedSelection {
  return { kind: "selectedReplacementOrCursor", textBeforeCursor };
}

function collapsedAfter(textBeforeCursor: string): ExpectedSelection {
  return { kind: "collapsedAfter", textBeforeCursor };
}

function expectedSelection(
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

function uniqueRangeForSubstring(text: string, substring: string) {
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

function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}
