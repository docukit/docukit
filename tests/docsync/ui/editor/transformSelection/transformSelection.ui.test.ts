import { test } from "@playwright/test";

import {
  createEditorPair,
  ORIGINAL_REFERENCE_SELECTION,
  SECOND_PARAGRAPH,
  THIRD_PARAGRAPH,
} from "../utils.js";
import {
  collapsedAfter,
  expectedSelection,
  expectedSelectionAcrossBlocks,
  FLAT_INITIAL_TEXT,
  INITIAL_BLOCKS,
  INITIAL_TEXT,
  globalOffsetToPoint,
  replaceRangeAcrossBlocks,
  replaceRange,
  selectedReplacementOrCursorAfter,
  selectedText,
  uniqueRangeForSubstring,
  type ExpectedSelection,
} from "./utils.js";

type RemoteCase = {
  description: string;
  remoteSubstring: string;
  referenceAfterEdit: ExpectedSelection;
};

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

const CROSS_PARAGRAPH_REFERENCE_SELECTION = {
  kind: "range" as const,
  anchor: { block: SECOND_PARAGRAPH, offset: 5 },
  focus: { block: THIRD_PARAGRAPH, offset: 7 },
};

const crossParagraphRemoteCases: RemoteCase[] = [
  {
    description: "the first part of the selection",
    remoteSubstring: "two.",
    referenceAfterEdit: selectedText("{replacement}\n\nItem th"),
  },
  {
    description: "the last part of the selection",
    remoteSubstring: "Item th",
    referenceAfterEdit: selectedText("two.\n\n{replacement}"),
  },
  {
    description: "the first part of the selection and one letter before",
    remoteSubstring: " two.",
    referenceAfterEdit: selectedText("\n\nItem th"),
  },
  {
    description: "the last part of the selection and one letter after",
    remoteSubstring: "Item thr",
    referenceAfterEdit: selectedText("two.\n\n"),
  },
  {
    description: "the exact selection",
    remoteSubstring: "two.\n\nItem th",
    referenceAfterEdit: selectedReplacementOrCursorAfter("Item one.\n\nItem "),
  },
  {
    description: "one letter before and after the selection",
    remoteSubstring: " two.\n\nItem thr",
    referenceAfterEdit: collapsedAfter("Item one.\n\nItem"),
  },
];

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

for (const remoteCase of crossParagraphRemoteCases) {
  for (const variant of remoteVariants) {
    test(`cross-paragraph remote user ${variant.action} ${remoteCase.description}`, async ({
      page,
      context,
    }) => {
      const remoteRange = uniqueRangeForSubstring(
        FLAT_INITIAL_TEXT,
        remoteCase.remoteSubstring,
      );
      const deletedLength = remoteRange.end - remoteRange.start;
      const replacement = variant.replacement(deletedLength);
      const remoteStart = globalOffsetToPoint(
        INITIAL_BLOCKS,
        remoteRange.start,
      );
      const remoteEnd = globalOffsetToPoint(INITIAL_BLOCKS, remoteRange.end);
      const expectedBlocks = replaceRangeAcrossBlocks(
        INITIAL_BLOCKS,
        remoteStart,
        remoteEnd,
        replacement ?? "",
      );
      const { reference, remote } = await createEditorPair(page, context);

      await reference.reference.selectRangeAcrossBlocks(
        CROSS_PARAGRAPH_REFERENCE_SELECTION.anchor,
        CROSS_PARAGRAPH_REFERENCE_SELECTION.focus,
      );
      await reference.reference.assertSelectionAcrossBlocks(
        CROSS_PARAGRAPH_REFERENCE_SELECTION,
      );

      await remote.otherDevice.selectRangeAcrossBlocks(remoteStart, remoteEnd);
      if (replacement == null) {
        await remote.otherDevice.press("Backspace");
      } else {
        await remote.otherDevice.type(replacement);
      }

      await reference.assertContent(expectedBlocks);
      await remote.assertContent(expectedBlocks);
      await reference.reference.assertSelectionAcrossBlocks(
        expectedSelectionAcrossBlocks(
          expectedBlocks,
          remoteCase.referenceAfterEdit,
          replacement,
          false,
        ),
      );
    });
  }
}

test("otherDevice updates the rendered remote cursor after an overlapping edit", async ({
  page,
  context,
}) => {
  const remoteSubstring = "em";
  const replacement = "xx";
  const remoteRange = uniqueRangeForSubstring(INITIAL_TEXT, remoteSubstring);
  const expectedAfterEdit = replaceRange(
    INITIAL_TEXT,
    remoteRange.start,
    remoteRange.end,
    replacement,
  );
  const expectedBlocks = ["Item one.", "Item two.", expectedAfterEdit];
  const { reference, remote } = await createEditorPair(page, context);

  // Existing tests in this file already prove that the local selection inside
  // `reference` is remapped correctly after a remote overlapping edit.
  //
  // This test covers the extra end-to-end piece: `otherDevice` must redraw the
  // remote cursor/range against the new text, even when the presence payload is
  // unchanged because a same-length replacement keeps the offsets stable.
  await reference.reference.selectRange(THIRD_PARAGRAPH, 2, 7);
  await reference.reference.assertSelection(ORIGINAL_REFERENCE_SELECTION);
  await remote.otherDevice.assertRemoteSelection(
    "user1",
    ORIGINAL_REFERENCE_SELECTION,
  );

  // `otherDevice` changes text that overlaps `reference`'s selection. That
  // forces `reference` to remap its local selection immediately.
  await remote.otherDevice.selectRange(
    THIRD_PARAGRAPH,
    remoteRange.start,
    remoteRange.end,
  );
  await remote.otherDevice.type(replacement);

  await reference.assertContent(expectedBlocks);
  await remote.assertContent(expectedBlocks);
  await reference.reference.assertSelection(
    expectedSelection(
      expectedAfterEdit,
      selectedText(`${replacement} th`),
      replacement,
    ),
  );

  // The important assertion here is on the rendered remote selection in
  // `otherDevice`; the local assertion above only proves the source selection.
  await remote.otherDevice.assertRemoteSelection(
    "user1",
    expectedSelection(
      expectedAfterEdit,
      selectedText(`${replacement} th`),
      replacement,
    ),
  );
});

test("remote user splits a paragraph in the middle of the selection", async ({
  page,
  context,
}) => {
  const { reference, remote } = await createEditorPair(page, context);
  const expectedBlocks = ["Item one.", "Item two.", "Item", " three."];

  await reference.reference.selectRange(THIRD_PARAGRAPH, 2, 7);
  await reference.reference.assertSelection(ORIGINAL_REFERENCE_SELECTION);

  await remote.otherDevice.select(THIRD_PARAGRAPH, 4);
  await remote.otherDevice.press("Enter");

  await reference.assertContent(expectedBlocks);
  await remote.assertContent(expectedBlocks);
  await reference.reference.assertSelectionAcrossBlocks({
    kind: "range",
    text: "em\n\n th",
    anchor: { block: THIRD_PARAGRAPH, offset: 2 },
    focus: { block: THIRD_PARAGRAPH + 1, offset: 3 },
  });
});
