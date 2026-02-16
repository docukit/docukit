import { createDOMRange, createRectsFromDOMRange } from "@lexical/selection";
import { $isLineBreakNode, type NodeKey, type NodeMap } from "lexical";
import type { Cursor, CursorSelection, PresenceBinding } from "./types.js";

export function createCursor(name: string, color: string): Cursor {
  return { color, name, selection: undefined };
}

function destroySelection(
  binding: PresenceBinding,
  selection: CursorSelection,
): void {
  const cursorsContainer = binding.cursorsContainer;
  if (cursorsContainer) {
    for (const sel of selection.selections) {
      cursorsContainer.removeChild(sel);
    }
  }
}

export function destroyCursor(binding: PresenceBinding, cursor: Cursor): void {
  if (cursor.selection) {
    destroySelection(binding, cursor.selection);
  }
}

export function createCursorSelection(
  cursor: Cursor,
  anchorKey: NodeKey,
  anchorOffset: number,
  focusKey: NodeKey,
  focusOffset: number,
): CursorSelection {
  const { color } = cursor;

  // Create caret element (the vertical line)
  const caret = document.createElement("span");
  caret.style.cssText = `position:absolute;top:0;bottom:0;right:-1px;width:2px;background-color:${color};z-index:10;`;

  // Create name label
  const name = document.createElement("span");
  name.textContent = cursor.name;
  name.style.cssText = `position:absolute;left:-2px;top:-18px;background-color:${color};color:#fff;line-height:12px;font-size:11px;padding:2px 4px;font-family:system-ui,sans-serif;font-weight:500;white-space:nowrap;border-radius:2px;pointer-events:none;`;
  caret.appendChild(name);

  return {
    anchor: { key: anchorKey, offset: anchorOffset },
    focus: { key: focusKey, offset: focusOffset },
    caret,
    color,
    name,
    selections: [],
  };
}

export function updateCursor(
  binding: PresenceBinding,
  cursor: Cursor,
  nextSelection: CursorSelection | undefined,
  nodeMap: NodeMap,
): void {
  const { editor, cursorsContainer } = binding;
  const rootElement = editor.getRootElement();

  if (!cursorsContainer || !rootElement) return;

  const cursorsContainerOffsetParent = cursorsContainer.offsetParent;
  if (!cursorsContainerOffsetParent) return;

  const containerRect = cursorsContainerOffsetParent.getBoundingClientRect();
  const prevSelection = cursor.selection;

  if (!nextSelection) {
    if (prevSelection) {
      cursor.selection = undefined;
      destroySelection(binding, prevSelection);
    }
    return;
  }

  cursor.selection = nextSelection;

  const { caret, color, selections, anchor, focus } = nextSelection;
  const anchorNode = nodeMap.get(anchor.key);
  const focusNode = nodeMap.get(focus.key);

  if (!anchorNode || !focusNode) return;

  let selectionRects: DOMRect[];

  // Handle collapsed selection on linebreak (browsers return nothing for <br>)
  if (anchorNode === focusNode && $isLineBreakNode(anchorNode)) {
    const brElement = editor.getElementByKey(anchor.key)!;
    selectionRects = [brElement.getBoundingClientRect()];
  } else {
    const range = createDOMRange(
      editor,
      anchorNode,
      anchor.offset,
      focusNode,
      focus.offset,
    );

    if (!range) {
      return;
    }
    selectionRects = createRectsFromDOMRange(editor, range);
  }

  const selectionsLength = selections.length;
  const selectionRectsLength = selectionRects.length;

  // Create/update selection highlight spans
  for (let i = 0; i < selectionRectsLength; i++) {
    const selectionRect = selectionRects[i];
    if (!selectionRect) continue;

    let selection = selections[i];

    if (!selection) {
      selection = document.createElement("span");
      selections[i] = selection;
      const selectionBg = document.createElement("span");
      selection.appendChild(selectionBg);
      cursorsContainer.appendChild(selection);
    }

    const top = selectionRect.top - containerRect.top;
    const left = selectionRect.left - containerRect.left;
    const style = `position:absolute;top:${top}px;left:${left}px;height:${selectionRect.height}px;width:${selectionRect.width}px;pointer-events:none;z-index:5;`;
    selection.style.cssText = style;

    (selection.firstChild as HTMLSpanElement).style.cssText =
      `${style}left:0;top:0;background-color:${color};opacity:0.3;`;

    // Append caret to the last selection rect
    if (i === selectionRectsLength - 1) {
      if (caret.parentNode !== selection) {
        selection.appendChild(caret);
      }
    }
  }

  // Remove extra selection spans
  for (let i = selectionsLength - 1; i >= selectionRectsLength; i--) {
    const selection = selections[i];
    if (selection) {
      cursorsContainer.removeChild(selection);
    }
    selections.pop();
  }
}
