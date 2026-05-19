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

const ENDPOINT_SEPARATOR = "\n";

type SelectionPoint = { key: string; offset: number };

type EndpointBookmark = {
  key: string;
  offset: number;
  text: string;
  path: number[];
  parentKey: string;
  indexInParent: number;
  previousSiblingKey: string | undefined;
  nextSiblingKey: string | undefined;
  nextTextKey: string | undefined;
};

type SelectionTransformState = {
  anchor: EndpointBookmark;
  focus: EndpointBookmark;
};

type CombinedEndpointText = {
  oldText: string;
  endpointOffset: number;
  otherOffset: number;
};

type TextMatch = { node: TextNode; startOffset: number };

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

  return { anchor, focus };
}

export function transformSelection(
  state: SelectionTransformState | undefined,
): void {
  if (!state) {
    return;
  }

  let nextAnchor = resolveEndpoint(state.anchor, "anchor", state);
  let nextFocus = resolveEndpoint(state.focus, "focus", state);
  if (!nextAnchor || !nextFocus) {
    const recoveredRange = resolveSameTextSelectionTailFromDocument(state);
    if (!recoveredRange) {
      return;
    }

    nextAnchor = recoveredRange.anchor;
    nextFocus = recoveredRange.focus;
  }

  const recoveredRange = resolveCollapsedSameTextSelectionTail(
    state,
    nextAnchor,
    nextFocus,
  );
  if (recoveredRange) {
    nextAnchor = recoveredRange.anchor;
    nextFocus = recoveredRange.focus;
  }

  const nextSelection = $createRangeSelection();
  nextSelection.anchor.set(nextAnchor.key, nextAnchor.offset, "text");
  nextSelection.focus.set(nextFocus.key, nextFocus.offset, "text");
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
    path: getPathFromRoot(node),
    parentKey: parent.getKey(),
    indexInParent: node.getIndexWithinParent(),
    previousSiblingKey: node.getPreviousSibling()?.getKey(),
    nextSiblingKey: node.getNextSibling()?.getKey(),
    nextTextKey: getNextTextNode(node)?.getKey(),
  };
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

  const bridged = resolveRemovedEndpointFromSurvivingEndpoint(
    endpoint,
    role,
    state,
  );
  if (bridged) {
    return bridged;
  }

  const recreated = resolveRemovedEndpointByTextPosition(endpoint, role, state);
  if (recreated) {
    return recreated;
  }

  return resolveRemovedEndpoint(endpoint);
}

function resolveSurvivingEndpoint(
  endpoint: EndpointBookmark,
  role: "anchor" | "focus",
  state: SelectionTransformState,
  node: TextNode,
): SelectionPoint {
  const bridged = resolveSurvivingEndpointFromRemovedEndpoint(
    endpoint,
    role,
    state,
    node,
  );
  if (bridged) {
    return bridged;
  }

  const nextText = node.getTextContent();
  const replacement = getTextReplacement(endpoint.text, nextText);
  const { selectionStart, selectionEnd } = getEndpointSelectionRange(
    endpoint,
    state,
  );
  const splitSuffix = resolveEndpointMovedToSplitSuffix(
    endpoint,
    node,
    replacement,
  );
  if (splitSuffix) {
    return splitSuffix;
  }

  if (
    state.anchor.key === state.focus.key &&
    replacement.start < selectionStart &&
    replacement.oldEnd > selectionEnd
  ) {
    return { key: node.getKey(), offset: replacement.start };
  }

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

function resolveEndpointMovedToSplitSuffix(
  endpoint: EndpointBookmark,
  node: TextNode,
  replacement: TextReplacement,
): SelectionPoint | undefined {
  if (replacement.start !== replacement.newEnd) {
    return;
  }
  if (replacement.oldEnd !== endpoint.text.length) {
    return;
  }
  if (endpoint.offset <= replacement.start) {
    return;
  }

  const movedText = endpoint.text.slice(replacement.start);
  const nextTextNode = getNextTextNodeMatching(node, (textNode) =>
    textNode.getTextContent().startsWith(movedText),
  );
  if (nextTextNode?.getKey() === endpoint.nextTextKey) {
    return;
  }
  if (!nextTextNode) {
    return;
  }

  const nextOffset = endpoint.offset - replacement.start;
  if (nextOffset > nextTextNode.getTextContentSize()) {
    return;
  }

  return { key: nextTextNode.getKey(), offset: nextOffset };
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

function resolveCollapsedSameTextSelectionTail(
  state: SelectionTransformState,
  anchor: SelectionPoint,
  focus: SelectionPoint,
): { anchor: SelectionPoint; focus: SelectionPoint } | undefined {
  if (state.anchor.key !== state.focus.key) {
    return;
  }
  if (state.anchor.offset === state.focus.offset) {
    return;
  }
  if (anchor.key !== focus.key || anchor.offset !== focus.offset) {
    return;
  }

  const match =
    getSelectedTailMatch(anchor, state) ?? getSelectedTailMatch(focus, state);
  if (!match) {
    return;
  }

  const endOffset = match.startOffset + match.text.length;
  if (state.anchor.offset <= state.focus.offset) {
    return {
      anchor: { key: match.node.getKey(), offset: match.startOffset },
      focus: { key: match.node.getKey(), offset: endOffset },
    };
  }

  return {
    anchor: { key: match.node.getKey(), offset: endOffset },
    focus: { key: match.node.getKey(), offset: match.startOffset },
  };
}

function resolveSameTextSelectionTailFromDocument(
  state: SelectionTransformState,
): { anchor: SelectionPoint; focus: SelectionPoint } | undefined {
  if (state.anchor.key !== state.focus.key) {
    return;
  }
  if (state.anchor.offset === state.focus.offset) {
    return;
  }

  const match = getSelectedTailMatchNearPath(state);
  if (!match) {
    return;
  }

  const endOffset = match.startOffset + match.text.length;
  if (state.anchor.offset <= state.focus.offset) {
    return {
      anchor: { key: match.node.getKey(), offset: match.startOffset },
      focus: { key: match.node.getKey(), offset: endOffset },
    };
  }

  return {
    anchor: { key: match.node.getKey(), offset: endOffset },
    focus: { key: match.node.getKey(), offset: match.startOffset },
  };
}

function getSelectedTailMatch(
  point: SelectionPoint,
  state: SelectionTransformState,
): (TextMatch & { text: string }) | undefined {
  const node = getAttachedTextNode(point.key);
  if (!node) {
    return;
  }

  const selectionStart = Math.min(state.anchor.offset, state.focus.offset);
  const selectionEnd = Math.max(state.anchor.offset, state.focus.offset);
  const selectedText = state.anchor.text.slice(selectionStart, selectionEnd);
  const nodeText = node.getTextContent();
  const minimumLength = Math.min(2, selectedText.length);
  const searchOffset = Math.min(point.offset, nodeText.length);

  for (
    let prefixLength = 0;
    prefixLength <= selectedText.length - minimumLength;
    prefixLength++
  ) {
    const text = selectedText.slice(prefixLength);
    const startOffset = nodeText.lastIndexOf(text, searchOffset);
    if (startOffset !== -1) {
      return { node, startOffset, text };
    }
  }
}

function getSelectedTailMatchNearPath(
  state: SelectionTransformState,
): (TextMatch & { text: string }) | undefined {
  const selectionStart = Math.min(state.anchor.offset, state.focus.offset);
  const selectionEnd = Math.max(state.anchor.offset, state.focus.offset);
  const selectedText = state.anchor.text.slice(selectionStart, selectionEnd);
  const minimumLength = Math.min(2, selectedText.length);

  for (
    let prefixLength = 0;
    prefixLength <= selectedText.length - minimumLength;
    prefixLength++
  ) {
    const text = selectedText.slice(prefixLength);
    const match =
      getTextMatchAtOrBeforePath(state.focus.path, text, state.focus.key) ??
      getTextMatchAtOrAfterPath(state.focus.path, text, state.focus.key);
    if (match) {
      return { ...match, text };
    }
  }
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

function resolveRemovedEndpointByTextPosition(
  endpoint: EndpointBookmark,
  role: "anchor" | "focus",
  state: SelectionTransformState,
): SelectionPoint | undefined {
  if (endpoint.text.length === 0) {
    return;
  }

  const other = role === "anchor" ? state.focus : state.anchor;
  const endpointIsAfterOther = comparePaths(other.path, endpoint.path) < 0;
  const otherNode = getAttachedTextNode(other.key);
  const searchPath = otherNode ? getPathFromRoot(otherNode) : other.path;
  const match = endpointIsAfterOther
    ? getTextMatchAtOrAfterPath(searchPath, endpoint.text, other.key)
    : getTextMatchAtOrBeforePath(searchPath, endpoint.text, other.key);

  const nextOffset = match ? match.startOffset + endpoint.offset : 0;
  if (!match || nextOffset > match.node.getTextContentSize()) {
    return;
  }

  return { key: match.node.getKey(), offset: nextOffset };
}

function resolveRemovedEndpointFromSurvivingEndpoint(
  endpoint: EndpointBookmark,
  role: "anchor" | "focus",
  state: SelectionTransformState,
): SelectionPoint | undefined {
  const other = role === "anchor" ? state.focus : state.anchor;
  const otherNode = getAttachedTextNode(other.key);
  if (!otherNode) {
    return;
  }

  const movedAfterOther = resolveRemovedEndpointMovedAfterSurvivingEndpoint(
    endpoint,
    other,
    otherNode,
  );
  if (movedAfterOther) {
    return movedAfterOther;
  }

  const recreated = resolveRemovedEndpointByTextPosition(endpoint, role, state);
  if (recreated) {
    return recreated;
  }

  return resolveEndpointAgainstCombinedText(endpoint, role, other, otherNode);
}

function resolveRemovedEndpointMovedAfterSurvivingEndpoint(
  endpoint: EndpointBookmark,
  other: EndpointBookmark,
  otherNode: TextNode,
): SelectionPoint | undefined {
  if (endpoint.text.length === 0) {
    return;
  }
  if (comparePaths(other.path, endpoint.path) >= 0) {
    return;
  }

  const otherMovedSuffix = getMovedSuffix(other, otherNode);
  if (other.nextTextKey !== endpoint.key && !otherMovedSuffix) {
    return;
  }

  if (otherMovedSuffix) {
    const nextTextNode = getNextTextNode(otherNode);
    if (!nextTextNode?.getTextContent().startsWith(otherMovedSuffix)) {
      return;
    }
  }

  const nextTextNode = getNextTextNodeMatching(otherNode, (textNode) =>
    textNode.getTextContent().startsWith(endpoint.text),
  );
  if (!nextTextNode || endpoint.offset > nextTextNode.getTextContentSize()) {
    return;
  }

  return { key: nextTextNode.getKey(), offset: endpoint.offset };
}

function getMovedSuffix(
  endpoint: EndpointBookmark,
  node: TextNode,
): string | undefined {
  const replacement = getTextReplacement(endpoint.text, node.getTextContent());
  if (replacement.start !== replacement.newEnd) {
    return;
  }
  if (replacement.oldEnd !== endpoint.text.length) {
    return;
  }

  const suffix = endpoint.text.slice(replacement.start);
  return suffix.length > 0 ? suffix : undefined;
}

function resolveSurvivingEndpointFromRemovedEndpoint(
  endpoint: EndpointBookmark,
  role: "anchor" | "focus",
  state: SelectionTransformState,
  node: TextNode,
): SelectionPoint | undefined {
  const other = role === "anchor" ? state.focus : state.anchor;
  if (getAttachedTextNode(other.key)) {
    return;
  }

  return resolveEndpointAgainstCombinedText(endpoint, role, other, node);
}

function resolveEndpointAgainstCombinedText(
  endpoint: EndpointBookmark,
  role: "anchor" | "focus",
  other: EndpointBookmark,
  node: TextNode,
): SelectionPoint | undefined {
  const combined = getCombinedEndpointText(endpoint, other);
  const replacement = getTextReplacement(
    combined.oldText,
    node.getTextContent(),
  );
  const selectionStart = Math.min(
    combined.endpointOffset,
    combined.otherOffset,
  );
  const selectionEnd = Math.max(combined.endpointOffset, combined.otherOffset);

  const nextOffset = remapSelectionEndpointForReplacement({
    offset: combined.endpointOffset,
    role,
    selectionStart,
    selectionEnd,
    replacement,
  });
  if (nextOffset < 0 || nextOffset > node.getTextContentSize()) {
    return;
  }

  return { key: node.getKey(), offset: nextOffset };
}

function getCombinedEndpointText(
  endpoint: EndpointBookmark,
  other: EndpointBookmark,
): CombinedEndpointText {
  const endpointIsAfterOther = comparePaths(other.path, endpoint.path) < 0;
  const separatorLength = ENDPOINT_SEPARATOR.length;

  // The separator only preserves ordering across two formerly separate text
  // nodes; it is not meant to model rendered paragraph text.
  return {
    oldText: endpointIsAfterOther
      ? `${other.text}${ENDPOINT_SEPARATOR}${endpoint.text}`
      : `${endpoint.text}${ENDPOINT_SEPARATOR}${other.text}`,
    endpointOffset: endpointIsAfterOther
      ? other.text.length + separatorLength + endpoint.offset
      : endpoint.offset,
    otherOffset: endpointIsAfterOther
      ? other.offset
      : endpoint.text.length + separatorLength + other.offset,
  };
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

function getNextTextNode(node: LexicalNode): TextNode | undefined {
  return getNextTextNodeMatching(node, () => true);
}

function getNextTextNodeMatching(
  node: LexicalNode,
  predicate: (node: TextNode) => boolean,
): TextNode | undefined {
  let current: LexicalNode | undefined = node;

  while (current) {
    const nextSibling = current.getNextSibling();
    if (nextSibling) {
      const nextText = firstTextInNodeOrFollowingSiblings(
        nextSibling,
        predicate,
      );
      if (nextText) {
        return nextText;
      }
    }
    current = current.getParent() ?? undefined;
  }
}

function firstTextInNodeOrFollowingSiblings(
  node: LexicalNode,
  predicate: (node: TextNode) => boolean,
): TextNode | undefined {
  let current: LexicalNode | undefined = node;

  while (current) {
    const text = firstTextInNode(current, predicate);
    if (text) {
      return text;
    }
    current = current.getNextSibling() ?? undefined;
  }
}

function firstTextInNode(
  node: LexicalNode,
  predicate: (node: TextNode) => boolean,
): TextNode | undefined {
  if ($isTextNode(node)) {
    return predicate(node) ? node : undefined;
  }
  if ($isElementNode(node)) {
    return getFirstTextDescendantMatching(node, predicate);
  }
}

function getFirstTextDescendantMatching(
  node: ElementNode,
  predicate: (node: TextNode) => boolean,
): TextNode | undefined {
  for (const child of node.getChildren()) {
    if ($isTextNode(child) && predicate(child)) {
      return child;
    }
    if ($isElementNode(child)) {
      const text = getFirstTextDescendantMatching(child, predicate);
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

function getPathFromRoot(node: LexicalNode): number[] {
  const path = [node.getIndexWithinParent()];
  const parents = node.getParents();

  for (let index = 0; index < parents.length - 1; index++) {
    const parent = parents[index];
    if (parent) {
      path.unshift(parent.getIndexWithinParent());
    }
  }

  return path;
}

function getTextMatchAtOrAfterPath(
  path: number[],
  text: string,
  excludeKey: string,
): TextMatch | undefined {
  return getTextDescendantMatchAtPath(
    $getRoot(),
    path,
    text,
    "after",
    excludeKey,
  );
}

function getTextMatchAtOrBeforePath(
  path: number[],
  text: string,
  excludeKey: string,
): TextMatch | undefined {
  return getTextDescendantMatchAtPath(
    $getRoot(),
    path,
    text,
    "before",
    excludeKey,
  );
}

function getTextDescendantMatchAtPath(
  node: LexicalNode,
  path: number[],
  text: string,
  direction: "after" | "before",
  excludeKey: string,
): TextMatch | undefined {
  if ($isTextNode(node)) {
    const comparison = comparePaths(getPathFromRoot(node), path);
    const isCandidate =
      direction === "after" ? comparison >= 0 : comparison <= 0;
    if (!isCandidate || node.getKey() === excludeKey) {
      return;
    }

    const nodeText = node.getTextContent();
    const startOffset =
      direction === "after"
        ? nodeText.indexOf(text)
        : nodeText.lastIndexOf(text);
    return startOffset === -1 ? undefined : { node, startOffset };
  }

  if (!$isElementNode(node)) {
    return;
  }

  const children = node.getChildren();
  if (direction === "after") {
    for (const child of children) {
      const textNode = getTextDescendantMatchAtPath(
        child,
        path,
        text,
        direction,
        excludeKey,
      );
      if (textNode) {
        return textNode;
      }
    }
    return;
  }

  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (!child) {
      continue;
    }

    const textNode = getTextDescendantMatchAtPath(
      child,
      path,
      text,
      direction,
      excludeKey,
    );
    if (textNode) {
      return textNode;
    }
  }
}

function comparePaths(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index++) {
    const delta = left[index]! - right[index]!;
    if (delta !== 0) {
      return delta;
    }
  }

  return left.length - right.length;
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

function remapSelectionEndpointForReplacement(args: {
  offset: number;
  role: "anchor" | "focus";
  selectionStart: number;
  selectionEnd: number;
  replacement: TextReplacement;
}): number {
  if (
    args.replacement.start < args.selectionStart &&
    args.replacement.oldEnd > args.selectionEnd
  ) {
    return args.replacement.start;
  }

  return remapSelectionEndpoint(args);
}
