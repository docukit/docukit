import { type Doc, type Operations } from "@docukit/docnode";
import {
  $createRangeSelection,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $parseSerializedNode,
  $getSelection,
  $setSelection,
  COLLABORATION_TAG,
  type LexicalEditor,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
} from "lexical";

import { LexicalDocNode } from "./lexicalDocNode.js";
import {
  getIsApplyingOwnChanges,
  setIsApplyingOwnChanges,
} from "./syncLexicalToDocNode.js";
import type { KeyBinding } from "./types.js";

type TextReplacement = { start: number; oldEnd: number; newEnd: number };
const SELECTION_CONTEXT_WINDOW = 8;

type EndpointMemory = {
  mappedOffset: number;
  restoreOffset: number;
  beforeContext: string;
  afterContext: string;
};

type SelectionMemory = {
  nodeKey: NodeKey;
  anchor?: EndpointMemory;
  focus?: EndpointMemory;
};

export function syncDocNodeToLexical(
  doc: Doc,
  editor: LexicalEditor,
  keyBinding: KeyBinding,
) {
  let selectionMemory: SelectionMemory | undefined;

  // Sync DocNode → Lexical using operations
  const unregisterDocListener = doc.onChange(({ operations }) => {
    // Skip if this editor is currently applying its own changes to Doc
    // This prevents reapplying changes when using a shared Doc
    if (getIsApplyingOwnChanges(editor)) {
      return;
    }

    // Mark that we're applying remote changes to prevent loops
    setIsApplyingOwnChanges(editor, true);

    try {
      editor.update(
        () => {
          selectionMemory = $applyDocNodeOperations(
            doc,
            operations,
            keyBinding,
            selectionMemory,
          );
        },
        {
          discrete: true,
          skipTransforms: true,
          // Use COLLABORATION_TAG to prevent DOM selection updates when editor is not focused
          tag: COLLABORATION_TAG,
        },
      );
    } finally {
      // Reset flag after update completes (including any triggered updates)
      setIsApplyingOwnChanges(editor, false);
    }
  });

  return unregisterDocListener;
}

/**
 * Apply DocNode operations to Lexical editor
 * Processes operations in order: inserts, deletes, moves, then state updates
 */
function $applyDocNodeOperations(
  doc: Doc,
  operations: Operations,
  keyBinding: KeyBinding,
  selectionMemory: SelectionMemory | undefined,
): SelectionMemory | undefined {
  const { lexicalKeyToDocNodeId, docNodeIdToLexicalKey } = keyBinding;
  const [orderedOps, statePatch] = operations;
  const lexicalRoot = $getRoot();
  let nextSelectionMemory = selectionMemory;

  // Helper: Get Lexical node by DocNode ID
  const getLexicalNode = (docNodeId: string | 0) => {
    if (docNodeId === 0) {
      return lexicalRoot;
    }
    const lexicalKey = docNodeIdToLexicalKey.get(docNodeId);
    if (!lexicalKey) {
      return null;
    }
    return $getNodeByKey(lexicalKey);
  };

  // Helper: Create Lexical nodes from DocNode (NON-recursive, children are inserted via separate operations)
  const createLexicalNodes = (docNodeIds: string[]): LexicalNode[] => {
    const nodes: LexicalNode[] = [];

    for (const docNodeId of docNodeIds) {
      const docNode = doc.getNodeById(docNodeId);

      // Skip if node doesn't exist (may have been deleted)
      if (!docNode?.is(LexicalDocNode)) {
        continue;
      }

      const serialized = docNode.state.j.get();
      const lexicalNode = $parseSerializedNode(serialized);

      // Update mappings
      const lexicalKey = lexicalNode.getKey();
      lexicalKeyToDocNodeId.set(lexicalKey, docNodeId);
      docNodeIdToLexicalKey.set(docNodeId, lexicalKey);

      nodes.push(lexicalNode);
    }

    return nodes;
  };

  // Process ordered operations
  for (const op of orderedOps) {
    switch (op[0]) {
      // INSERT: [0, nodes, parent, prev, next]
      case 0: {
        const [, nodeInfos, parentId, prevId, nextId] = op;
        const nodeIds = nodeInfos.map(([id]) => id);
        const lexicalNodes = createLexicalNodes(nodeIds);

        // Determine insertion point
        if (prevId !== 0) {
          const prevNode = getLexicalNode(prevId);
          if (prevNode) {
            // Insert each node after the previous one
            let insertAfter = prevNode;
            lexicalNodes.forEach((node) => {
              insertAfter.insertAfter(node);
              insertAfter = node;
            });
          }
        } else if (nextId !== 0) {
          const nextNode = getLexicalNode(nextId);
          if (nextNode) {
            // Insert all nodes before nextNode (in reverse order)
            lexicalNodes.reverse().forEach((node) => {
              nextNode.insertBefore(node);
            });
          }
        } else {
          // Append to parent
          const parent = getLexicalNode(parentId);
          if (parent && $isElementNode(parent)) {
            parent.append(...lexicalNodes);
          }
        }
        break;
      }

      // DELETE: [1, start, end]
      case 1: {
        const [, startId, endId] = op;
        const startKey = docNodeIdToLexicalKey.get(startId);
        if (!startKey) {
          break;
        }

        const startNode = $getNodeByKey(startKey);
        if (!startNode) {
          break;
        }

        // Delete range from start to end (inclusive)
        if (endId === 0) {
          // Single node delete
          lexicalKeyToDocNodeId.delete(startKey);
          docNodeIdToLexicalKey.delete(startId);
          startNode.remove();
        } else {
          // Range delete
          const endKey = docNodeIdToLexicalKey.get(endId);
          if (!endKey) {
            break;
          }

          // Collect all nodes to delete
          const nodesToDelete: NodeKey[] = [startKey];
          let current = startNode.getNextSibling();
          while (current && current.getKey() !== endKey) {
            nodesToDelete.push(current.getKey());
            current = current.getNextSibling();
          }
          if (current) {
            nodesToDelete.push(endKey);
          }

          // Delete and clean up mappings
          nodesToDelete.forEach((key) => {
            const node = $getNodeByKey(key);
            const docNodeId = lexicalKeyToDocNodeId.get(key);
            if (docNodeId) {
              lexicalKeyToDocNodeId.delete(key);
              docNodeIdToLexicalKey.delete(docNodeId);
            }
            node?.remove();
          });
        }
        break;
      }

      // MOVE: [2, start, end, parent, prev, next]
      case 2: {
        const [, startId, endId, parentId, prevId, nextId] = op;
        const startKey = docNodeIdToLexicalKey.get(startId);
        if (!startKey) {
          break;
        }

        const startNode = $getNodeByKey(startKey);
        if (!startNode) {
          break;
        }

        // Collect nodes to move
        const nodesToMove: LexicalNode[] = [startNode];
        if (endId !== 0) {
          const endKey = docNodeIdToLexicalKey.get(endId);
          let current = startNode.getNextSibling();
          while (current && current.getKey() !== endKey) {
            nodesToMove.push(current);
            current = current.getNextSibling();
          }
          if (current) {
            nodesToMove.push(current);
          }
        }

        // Determine new position
        if (prevId !== 0) {
          const prevNode = getLexicalNode(prevId);
          if (prevNode) {
            nodesToMove.forEach((node) => {
              node.remove();
              prevNode.insertAfter(node);
            });
          }
        } else if (nextId !== 0) {
          const nextNode = getLexicalNode(nextId);
          if (nextNode) {
            nodesToMove.reverse().forEach((node) => {
              node.remove();
              nextNode.insertBefore(node);
            });
          }
        } else {
          // Append to parent
          const parent = getLexicalNode(parentId);
          if (parent && $isElementNode(parent)) {
            nodesToMove.forEach((node) => {
              node.remove();
              parent.append(node);
            });
          }
        }
        break;
      }
    }
  }

  // Apply state patches (update node properties)
  // updateFromJSON() safely updates properties while preserving children
  for (const docNodeId in statePatch) {
    const lexicalKey = docNodeIdToLexicalKey.get(docNodeId);
    if (!lexicalKey) {
      continue;
    }

    const lexicalNode = $getNodeByKey(lexicalKey);
    if (!lexicalNode) {
      continue;
    }

    const docNode = doc.getNodeById(docNodeId);
    if (!docNode?.is(LexicalDocNode)) {
      continue;
    }
    const serialized = docNode.state.j.get() as SerializedLexicalNode;
    nextSelectionMemory = $transformTextSelectionForUpdate(
      lexicalNode,
      serialized,
      nextSelectionMemory,
    );
    lexicalNode.getWritable().updateFromJSON(serialized);
  }

  return nextSelectionMemory;
}

function $transformTextSelectionForUpdate(
  lexicalNode: LexicalNode,
  serialized: SerializedLexicalNode,
  selectionMemory: SelectionMemory | undefined,
): SelectionMemory | undefined {
  if (!$isTextNode(lexicalNode)) return selectionMemory;

  const oldText = lexicalNode.getTextContent();
  const newText = getSerializedText(serialized);
  if (newText == null || oldText === newText) return selectionMemory;

  const replacement = getTextReplacement(oldText, newText);
  const nodeKey = lexicalNode.getKey();
  const restored = $restoreRememberedSelection(
    nodeKey,
    newText,
    selectionMemory,
  );
  if (restored) return undefined;

  const selection = $getSelection();
  if (
    !$isRangeSelection(selection) ||
    selection.anchor.key !== nodeKey ||
    selection.focus.key !== nodeKey
  ) {
    return selectionMemory;
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
    $setSelection(null);
    return {
      nodeKey,
      anchor: rememberEndpoint(oldText, replacement.start, replacement.start),
      focus: rememberEndpoint(oldText, replacement.oldEnd, replacement.newEnd),
    };
  }

  const anchor = transformEndpoint({
    oldText,
    offset: selection.anchor.offset,
    role: "anchor",
    selectionStart,
    selectionEnd,
    replacement,
    memory:
      selectionMemory?.nodeKey === nodeKey ? selectionMemory.anchor : undefined,
  });
  const focus = transformEndpoint({
    oldText,
    offset: selection.focus.offset,
    role: "focus",
    selectionStart,
    selectionEnd,
    replacement,
    memory:
      selectionMemory?.nodeKey === nodeKey ? selectionMemory.focus : undefined,
  });

  const nextSelection = $createRangeSelection();
  nextSelection.anchor.set(nodeKey, anchor.offset, "text");
  nextSelection.focus.set(nodeKey, focus.offset, "text");
  $setSelection(nextSelection);

  if (!anchor.memory && !focus.memory) return undefined;
  const nextSelectionMemory: SelectionMemory = { nodeKey };
  if (anchor.memory) nextSelectionMemory.anchor = anchor.memory;
  if (focus.memory) nextSelectionMemory.focus = focus.memory;
  return nextSelectionMemory;
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

function $restoreRememberedSelection(
  nodeKey: NodeKey,
  newText: string,
  selectionMemory: SelectionMemory | undefined,
): boolean {
  const anchorMemory = selectionMemory?.anchor;
  const focusMemory = selectionMemory?.focus;
  if (selectionMemory?.nodeKey !== nodeKey || !anchorMemory || !focusMemory) {
    return false;
  }

  const anchorOffset = restoreEndpointFromMemory(newText, anchorMemory);
  const focusOffset = restoreEndpointFromMemory(newText, focusMemory);
  if (anchorOffset == null || focusOffset == null) return false;

  const nextSelection = $createRangeSelection();
  nextSelection.anchor.set(nodeKey, anchorOffset, "text");
  nextSelection.focus.set(nodeKey, focusOffset, "text");
  $setSelection(nextSelection);
  return true;
}

function transformEndpoint({
  oldText,
  offset,
  role,
  selectionStart,
  selectionEnd,
  replacement,
  memory,
}: {
  oldText: string;
  offset: number;
  role: "anchor" | "focus";
  selectionStart: number;
  selectionEnd: number;
  replacement: TextReplacement;
  memory: EndpointMemory | undefined;
}): { offset: number; memory: EndpointMemory | undefined } {
  const restoredOffset = restoreEndpointFromCurrentOffset(offset, memory);
  if (restoredOffset != null) {
    return { offset: restoredOffset, memory: undefined };
  }

  const delta =
    replacement.newEnd -
    replacement.start -
    (replacement.oldEnd - replacement.start);

  if (offset < replacement.start) {
    return { offset, memory: undefined };
  }
  if (offset > replacement.oldEnd) {
    return { offset: offset + delta, memory: undefined };
  }

  let mappedOffset: number;
  if (offset === replacement.start) {
    mappedOffset = replacement.start;
  } else if (offset === replacement.oldEnd) {
    mappedOffset = replacement.newEnd;
  } else if (role === "anchor") {
    mappedOffset =
      replacement.start < selectionStart
        ? replacement.newEnd
        : replacement.start;
  } else {
    mappedOffset =
      replacement.oldEnd > selectionEnd
        ? replacement.start
        : replacement.newEnd;
  }

  return {
    offset: mappedOffset,
    memory: rememberEndpoint(oldText, offset, mappedOffset),
  };
}

function restoreEndpointFromCurrentOffset(
  offset: number,
  memory: EndpointMemory | undefined,
): number | undefined {
  if (memory?.mappedOffset !== offset) return undefined;
  return memory.restoreOffset;
}

function restoreEndpointFromMemory(
  text: string,
  memory: EndpointMemory,
): number | undefined {
  const exactMatches: number[] = [];
  const looseMatches: number[] = [];

  for (let offset = 0; offset <= text.length; offset++) {
    const beforeStart = Math.max(0, offset - memory.beforeContext.length);
    const beforeMatches =
      text.slice(beforeStart, offset) === memory.beforeContext;
    const afterMatches = text.startsWith(memory.afterContext, offset);

    if (beforeMatches && afterMatches) {
      exactMatches.push(offset);
      continue;
    }

    if (
      (memory.beforeContext.length > 0 && beforeMatches) ||
      (memory.afterContext.length > 0 && afterMatches)
    ) {
      looseMatches.push(offset);
    }
  }

  return chooseClosestOffset(
    exactMatches.length > 0 ? exactMatches : looseMatches,
    memory.mappedOffset,
  );
}

function rememberEndpoint(
  text: string,
  restoreOffset: number,
  mappedOffset: number,
): EndpointMemory {
  const beforeStart = Math.max(0, restoreOffset - SELECTION_CONTEXT_WINDOW);
  const afterEnd = Math.min(
    text.length,
    restoreOffset + SELECTION_CONTEXT_WINDOW,
  );
  return {
    mappedOffset,
    restoreOffset,
    beforeContext: text.slice(beforeStart, restoreOffset),
    afterContext: text.slice(restoreOffset, afterEnd),
  };
}

function chooseClosestOffset(
  offsets: readonly number[],
  target: number,
): number | undefined {
  let bestOffset: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const offset of offsets) {
    const distance = Math.abs(offset - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestOffset = offset;
    }
  }

  return bestOffset;
}
