import { test } from "@playwright/test";

import {
  collapsedAfter,
  createEditorPair,
  expectedSelection,
  INITIAL_TEXT,
  ORIGINAL_REFERENCE_SELECTION,
  replaceRange,
  selectedReplacementOrCursorAfter,
  selectedText,
  THIRD_PARAGRAPH,
  uniqueRangeForSubstring,
  type ExpectedSelection,
} from "./editorTestUtils.js";

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
