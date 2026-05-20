import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type LexicalNode,
  type TextNode,
} from "lexical";

type TextReplacement = { start: number; oldEnd: number; newEnd: number };

const BLOCK_SEPARATOR = "\n\n";

type SelectionPoint = { key: string; offset: number };

type DocumentTextBookmark = {
  text: string;
  anchorOffset: number;
  focusOffset: number;
};

type SelectionTransformState = DocumentTextBookmark;

type TextSnapshot = { text: string; spans: TextSpan[] };

type TextSpan = { node: TextNode; start: number; end: number };

export function captureSelectionTransformState():
  | SelectionTransformState
  | undefined {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return;
  }

  return captureDocumentTextBookmark(
    selection.anchor.key,
    selection.anchor.offset,
    selection.focus.key,
    selection.focus.offset,
  );
}

export function transformSelection(
  state: SelectionTransformState | undefined,
): void {
  if (!state) {
    return;
  }

  const textSelection = resolveSelectionFromDocumentText(state);
  if (textSelection) {
    setRangeSelection(textSelection.anchor, textSelection.focus);
  }
}

function setRangeSelection(
  anchor: SelectionPoint,
  focus: SelectionPoint,
): void {
  const nextSelection = $createRangeSelection();
  nextSelection.anchor.set(anchor.key, anchor.offset, "text");
  nextSelection.focus.set(focus.key, focus.offset, "text");
  $setSelection(nextSelection);
}

function captureDocumentTextBookmark(
  anchorKey: string,
  anchorPointOffset: number,
  focusKey: string,
  focusPointOffset: number,
): DocumentTextBookmark | undefined {
  const snapshot = getDocumentTextSnapshot();
  const anchorOffset = getSnapshotOffset(
    snapshot,
    anchorKey,
    anchorPointOffset,
  );
  const focusOffset = getSnapshotOffset(snapshot, focusKey, focusPointOffset);
  if (anchorOffset === undefined || focusOffset === undefined) {
    return;
  }

  return { text: snapshot.text, anchorOffset, focusOffset };
}

function resolveSelectionFromDocumentText(
  bookmark: SelectionTransformState,
): { anchor: SelectionPoint; focus: SelectionPoint } | undefined {
  const snapshot = getDocumentTextSnapshot();
  const replacement = getTextReplacement(bookmark.text, snapshot.text);
  const selectionStart = Math.min(bookmark.anchorOffset, bookmark.focusOffset);
  const selectionEnd = Math.max(bookmark.anchorOffset, bookmark.focusOffset);
  const anchorOffset = remapSelectionEndpoint({
    offset: bookmark.anchorOffset,
    role: "anchor",
    selectionStart,
    selectionEnd,
    replacement,
  });
  const focusOffset = remapSelectionEndpoint({
    offset: bookmark.focusOffset,
    role: "focus",
    selectionStart,
    selectionEnd,
    replacement,
  });
  const isForward = bookmark.anchorOffset <= bookmark.focusOffset;
  const anchor = pointFromSnapshotOffset(
    snapshot,
    anchorOffset,
    isForward ? "forward" : "backward",
  );
  const focus = pointFromSnapshotOffset(
    snapshot,
    focusOffset,
    isForward ? "backward" : "forward",
  );
  if (!anchor || !focus) {
    return;
  }

  return { anchor, focus };
}

function getDocumentTextSnapshot(): TextSnapshot {
  const spans: TextSpan[] = [];
  const parts: string[] = [];
  let offset = 0;

  const appendText = (text: string) => {
    parts.push(text);
    offset += text.length;
  };

  const appendNode = (node: LexicalNode) => {
    if ($isTextNode(node)) {
      const text = node.getTextContent();
      spans.push({ node, start: offset, end: offset + text.length });
      appendText(text);
      return;
    }

    if (!$isElementNode(node)) {
      return;
    }

    for (const child of node.getChildren()) {
      appendNode(child);
    }
  };

  const children = $getRoot().getChildren();
  for (const [index, child] of children.entries()) {
    if (index > 0) {
      appendText(BLOCK_SEPARATOR);
    }
    appendNode(child);
  }

  return { text: parts.join(""), spans };
}

function getSnapshotOffset(
  snapshot: TextSnapshot,
  key: string,
  offset: number,
): number | undefined {
  for (const span of snapshot.spans) {
    if (span.node.getKey() !== key) {
      continue;
    }

    return span.start + Math.min(offset, span.end - span.start);
  }
}

function pointFromSnapshotOffset(
  snapshot: TextSnapshot,
  offset: number,
  affinity: "forward" | "backward",
): SelectionPoint | undefined {
  const boundedOffset = Math.max(0, Math.min(offset, snapshot.text.length));
  let previous: TextSpan | undefined;

  for (const span of snapshot.spans) {
    if (boundedOffset < span.start) {
      return affinity === "backward" && previous
        ? pointAtEndOfSpan(previous)
        : { key: span.node.getKey(), offset: 0 };
    }

    if (boundedOffset <= span.end) {
      return { key: span.node.getKey(), offset: boundedOffset - span.start };
    }

    previous = span;
  }

  return previous ? pointAtEndOfSpan(previous) : undefined;
}

function pointAtEndOfSpan(span: TextSpan): SelectionPoint {
  return { key: span.node.getKey(), offset: span.end - span.start };
}

function getTextReplacement(oldText: string, newText: string): TextReplacement {
  // This intentionally models the update as one contiguous replacement.
  // That is enough for the current DocSync path where remote editor updates are
  // applied one at a time. If future batching can combine independent edits in
  // different parts of the document, this should become a multi-hunk diff or
  // leave the selection to Lexical's own node-removal selection normalization.
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
  if (replacement.start < selectionStart && replacement.oldEnd > selectionEnd) {
    return replacement.start;
  }

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
