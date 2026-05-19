import {
  $createRangeSelection,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
  type TextNode,
} from "lexical";

type TextReplacement = { start: number; oldEnd: number; newEnd: number };

const BLOCK_SEPARATOR = "\n\n";

type SelectionPoint = { key: string; offset: number };

type EndpointBookmark = {
  key: string;
  offset: number;
  text: string;
  parentKey: string;
  indexInParent: number;
  previousSiblingKey: string | undefined;
  nextSiblingKey: string | undefined;
};

type DocumentTextBookmark = {
  text: string;
  anchorOffset: number;
  focusOffset: number;
};

type SelectionTransformState = {
  anchor: EndpointBookmark;
  focus: EndpointBookmark;
  documentText: DocumentTextBookmark | undefined;
};

type TextSnapshot = { text: string; spans: TextSpan[] };

type TextSpan = { node: TextNode; start: number; end: number };

export function captureSelectionTransformState():
  | SelectionTransformState
  | undefined {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) {
    return;
  }

  const anchor = captureEndpoint(selection.anchor.key, selection.anchor.offset);
  const focus = captureEndpoint(selection.focus.key, selection.focus.offset);
  if (!anchor || !focus) {
    return;
  }

  return {
    anchor,
    focus,
    documentText: captureDocumentTextBookmark(anchor, focus),
  };
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
    return;
  }

  const nextAnchor = resolveEndpoint(state.anchor, "anchor", state);
  const nextFocus = resolveEndpoint(state.focus, "focus", state);
  if (!nextAnchor || !nextFocus) {
    return;
  }

  setRangeSelection(nextAnchor, nextFocus);
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

function captureEndpoint(
  key: string,
  offset: number,
): EndpointBookmark | undefined {
  const node = $getNodeByKey(key);
  if (!$isTextNode(node)) {
    return;
  }

  const parent = node.getParent<ElementNode>();
  if (!$isElementNode(parent)) {
    return;
  }

  return {
    key,
    offset,
    text: node.getTextContent(),
    parentKey: parent.getKey(),
    indexInParent: node.getIndexWithinParent(),
    previousSiblingKey: node.getPreviousSibling()?.getKey(),
    nextSiblingKey: node.getNextSibling()?.getKey(),
  };
}

function captureDocumentTextBookmark(
  anchor: EndpointBookmark,
  focus: EndpointBookmark,
): DocumentTextBookmark | undefined {
  const snapshot = getDocumentTextSnapshot();
  const anchorOffset = getSnapshotOffset(snapshot, anchor.key, anchor.offset);
  const focusOffset = getSnapshotOffset(snapshot, focus.key, focus.offset);
  if (anchorOffset === undefined || focusOffset === undefined) {
    return;
  }

  return { text: snapshot.text, anchorOffset, focusOffset };
}

function resolveSelectionFromDocumentText(
  state: SelectionTransformState,
): { anchor: SelectionPoint; focus: SelectionPoint } | undefined {
  const bookmark = state.documentText;
  if (!bookmark) {
    return;
  }

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

function resolveEndpoint(
  endpoint: EndpointBookmark,
  role: "anchor" | "focus",
  state: SelectionTransformState,
): SelectionPoint | undefined {
  const node = getAttachedTextNode(endpoint.key);
  if (node) {
    return resolveSurvivingEndpoint(endpoint, role, state, node);
  }

  return resolveRemovedEndpoint(endpoint);
}

function resolveSurvivingEndpoint(
  endpoint: EndpointBookmark,
  role: "anchor" | "focus",
  state: SelectionTransformState,
  node: TextNode,
): SelectionPoint {
  const nextText = node.getTextContent();
  const replacement = getTextReplacement(endpoint.text, nextText);
  const { selectionStart, selectionEnd } = getEndpointSelectionRange(
    endpoint,
    state,
  );

  return {
    key: node.getKey(),
    offset: remapSelectionEndpoint({
      offset: endpoint.offset,
      role,
      selectionStart,
      selectionEnd,
      replacement,
    }),
  };
}

function getEndpointSelectionRange(
  endpoint: EndpointBookmark,
  state: SelectionTransformState,
): { selectionStart: number; selectionEnd: number } {
  if (state.anchor.key !== state.focus.key) {
    return { selectionStart: endpoint.offset, selectionEnd: endpoint.offset };
  }

  return {
    selectionStart: Math.min(state.anchor.offset, state.focus.offset),
    selectionEnd: Math.max(state.anchor.offset, state.focus.offset),
  };
}

function resolveRemovedEndpoint(
  endpoint: EndpointBookmark,
): SelectionPoint | undefined {
  const previous = endpoint.previousSiblingKey
    ? getAttachedNode(endpoint.previousSiblingKey)
    : undefined;
  if (previous) {
    return endOfNode(previous);
  }

  const next = endpoint.nextSiblingKey
    ? getAttachedNode(endpoint.nextSiblingKey)
    : undefined;
  if (next) {
    return startOfNode(next);
  }

  const parent = getAttachedElementNode(endpoint.parentKey);
  if (parent) {
    return pointAtChildIndex(parent, endpoint.indexInParent);
  }
}

function pointAtChildIndex(
  parent: ElementNode,
  index: number,
): SelectionPoint | undefined {
  const childAtIndex = parent.getChildAtIndex(index);
  if (childAtIndex) {
    return startOfNode(childAtIndex);
  }

  const previous = parent.getChildAtIndex(index - 1);
  if (previous) {
    return endOfNode(previous);
  }

  return startOfNode(parent);
}

function startOfNode(node: LexicalNode): SelectionPoint | undefined {
  if ($isTextNode(node)) {
    return { key: node.getKey(), offset: 0 };
  }

  if (!$isElementNode(node)) {
    return;
  }

  const firstText = getFirstTextDescendant(node);
  return firstText ? { key: firstText.getKey(), offset: 0 } : undefined;
}

function endOfNode(node: LexicalNode): SelectionPoint | undefined {
  if ($isTextNode(node)) {
    return { key: node.getKey(), offset: node.getTextContentSize() };
  }

  if (!$isElementNode(node)) {
    return;
  }

  const lastText = getLastTextDescendant(node);
  return lastText
    ? { key: lastText.getKey(), offset: lastText.getTextContentSize() }
    : undefined;
}

function getFirstTextDescendant(node: ElementNode): TextNode | undefined {
  for (const child of node.getChildren()) {
    if ($isTextNode(child)) {
      return child;
    }
    if ($isElementNode(child)) {
      const text = getFirstTextDescendant(child);
      if (text) return text;
    }
  }
}

function getLastTextDescendant(node: ElementNode): TextNode | undefined {
  const children = node.getChildren();
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if ($isTextNode(child)) {
      return child;
    }
    if ($isElementNode(child)) {
      const text = getLastTextDescendant(child);
      if (text) return text;
    }
  }
}

function getAttachedTextNode(key: string): TextNode | undefined {
  const node = $getNodeByKey(key);
  return $isTextNode(node) && node.isAttached() ? node : undefined;
}

function getAttachedElementNode(key: string): ElementNode | undefined {
  const node = $getNodeByKey(key);
  return $isElementNode(node) && node.isAttached() ? node : undefined;
}

function getAttachedNode(key: string): LexicalNode | undefined {
  const node = $getNodeByKey(key);
  return node?.isAttached() ? node : undefined;
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
