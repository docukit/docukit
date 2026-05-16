import {
  $createRangeSelection,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type LexicalNode,
  type SerializedLexicalNode,
} from "lexical";

type TextReplacement = { start: number; oldEnd: number; newEnd: number };

export function transformSelection(
  lexicalNode: LexicalNode,
  serialized: SerializedLexicalNode,
): void {
  if (!$isTextNode(lexicalNode)) return;

  const oldText = lexicalNode.getTextContent();
  const newText = getSerializedText(serialized);
  if (newText == null || oldText === newText) return;

  const replacement = getTextReplacement(oldText, newText);
  const nodeKey = lexicalNode.getKey();
  const selection = $getSelection();
  if (
    !$isRangeSelection(selection) ||
    selection.anchor.key !== nodeKey ||
    selection.focus.key !== nodeKey
  ) {
    return;
  }

  const selectionStart = Math.min(
    selection.anchor.offset,
    selection.focus.offset,
  );
  const selectionEnd = Math.max(
    selection.anchor.offset,
    selection.focus.offset,
  );

  if (replacement.start < selectionStart && replacement.oldEnd > selectionEnd) {
    const nextSelection = $createRangeSelection();
    nextSelection.anchor.set(nodeKey, replacement.start, "text");
    nextSelection.focus.set(nodeKey, replacement.start, "text");
    $setSelection(nextSelection);
    return;
  }

  const anchor = remapSelectionEndpoint({
    offset: selection.anchor.offset,
    role: "anchor",
    selectionStart,
    selectionEnd,
    replacement,
  });
  const focus = remapSelectionEndpoint({
    offset: selection.focus.offset,
    role: "focus",
    selectionStart,
    selectionEnd,
    replacement,
  });

  const nextSelection = $createRangeSelection();
  nextSelection.anchor.set(nodeKey, anchor, "text");
  nextSelection.focus.set(nodeKey, focus, "text");
  $setSelection(nextSelection);
}

function getSerializedText(
  serialized: SerializedLexicalNode,
): string | undefined {
  if ("text" in serialized && typeof serialized.text === "string") {
    return serialized.text;
  }
  return undefined;
}

function getTextReplacement(oldText: string, newText: string): TextReplacement {
  let start = 0;
  while (
    start < oldText.length &&
    start < newText.length &&
    oldText[start] === newText[start]
  ) {
    start++;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText[oldEnd - 1] === newText[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }

  return { start, oldEnd, newEnd };
}

function remapSelectionEndpoint({
  offset,
  role,
  selectionStart,
  selectionEnd,
  replacement,
}: {
  offset: number;
  role: "anchor" | "focus";
  selectionStart: number;
  selectionEnd: number;
  replacement: TextReplacement;
}): number {
  const delta =
    replacement.newEnd -
    replacement.start -
    (replacement.oldEnd - replacement.start);

  if (offset < replacement.start) {
    return offset;
  }
  if (offset > replacement.oldEnd) {
    return offset + delta;
  }

  if (offset === replacement.start) {
    return replacement.start;
  }
  if (offset === replacement.oldEnd) {
    return replacement.newEnd;
  }

  if (role === "anchor") {
    return replacement.start < selectionStart
      ? replacement.newEnd
      : replacement.start;
  }

  return replacement.oldEnd > selectionEnd
    ? replacement.start
    : replacement.newEnd;
}
