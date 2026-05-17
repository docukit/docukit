import { test } from "@playwright/test";

import {
  createEditorPair,
  ORIGINAL_REFERENCE_SELECTION,
  THIRD_PARAGRAPH,
} from "../utils.js";
import {
  collapsedAfter,
  expectedSelection,
  INITIAL_TEXT,
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
  // This test covers the extra end-to-end piece: the remapped selection must
  // also be re-published through DocSync presence, so `otherDevice` redraws
  // the remote cursor/range in the right place instead of showing a stale one.
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

  // The important assertion here is on the rendered remote selection in
  // `otherDevice`, not on `reference`'s local selection state.
  await remote.otherDevice.assertRemoteSelection(
    "user1",
    expectedSelection(
      expectedAfterEdit,
      selectedText(`${replacement} th`),
      replacement,
    ),
  );
});
