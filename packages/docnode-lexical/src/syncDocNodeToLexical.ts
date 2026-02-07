import { type Doc, type Operations } from "@docukit/docnode";
import {
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $parseSerializedNode,
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

export function syncDocNodeToLexical(
  doc: Doc,
  editor: LexicalEditor,
  lexicalKeyToDocNodeId: Map<string, string>,
  docNodeIdToLexicalKey: Map<string, string>,
) {
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
          $applyDocNodeOperations(
            doc,
            operations,
            lexicalKeyToDocNodeId,
            docNodeIdToLexicalKey,
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
  lexicalKeyToDocNodeId: Map<string, string>,
  docNodeIdToLexicalKey: Map<string, string>,
): void {
  const [orderedOps, statePatch] = operations;
  const lexicalRoot = $getRoot();

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
    lexicalNode.getWritable().updateFromJSON(serialized);
  }
}
