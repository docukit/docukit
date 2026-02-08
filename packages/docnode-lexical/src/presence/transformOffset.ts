import {
  $getNodeByKey,
  $isTextNode,
  type EditorState,
  type NodeKey,
} from "lexical";
import type { CursorSelection } from "./types.js";

/**
 * Compute a new cursor offset after a text edit, using common prefix/suffix
 * to locate the edit range and shift the offset accordingly.
 */
function transformOffset(
  oldOffset: number,
  oldText: string,
  newText: string,
): number {
  if (oldText === newText) return oldOffset;

  // Find common prefix
  let prefixLen = 0;
  while (
    prefixLen < oldText.length &&
    prefixLen < newText.length &&
    oldText[prefixLen] === newText[prefixLen]
  ) {
    prefixLen++;
  }

  // Find common suffix (non-overlapping with prefix)
  let suffixLen = 0;
  while (
    suffixLen < oldText.length - prefixLen &&
    suffixLen < newText.length - prefixLen &&
    oldText[oldText.length - 1 - suffixLen] ===
      newText[newText.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const oldEditEnd = oldText.length - suffixLen;

  // Before edit: unchanged
  if (oldOffset < prefixLen) return oldOffset;
  // After edit: shift by size difference
  if (oldOffset >= oldEditEnd)
    return oldOffset + (newText.length - oldText.length);
  // Inside edit: snap to end of inserted text
  return newText.length - suffixLen;
}

/**
 * Transform a cursor selection's anchor/focus offsets for any dirty text leaves
 * whose content changed between prevEditorState and editorState.
 */
export function transformCursorSelection(
  selection: CursorSelection,
  dirtyLeaves: Set<NodeKey>,
  prevEditorState: EditorState,
  editorState: EditorState,
): boolean {
  let transformed = false;

  for (const point of [selection.anchor, selection.focus]) {
    if (!dirtyLeaves.has(point.key)) continue;

    const oldText = prevEditorState.read(() => {
      const node = $getNodeByKey(point.key);
      return $isTextNode(node) ? node.getTextContent() : null;
    });
    const newText = editorState.read(() => {
      const node = $getNodeByKey(point.key);
      return $isTextNode(node) ? node.getTextContent() : null;
    });

    if (oldText == null || newText == null || oldText === newText) continue;

    point.offset = transformOffset(point.offset, oldText, newText);
    transformed = true;
  }

  return transformed;
}
