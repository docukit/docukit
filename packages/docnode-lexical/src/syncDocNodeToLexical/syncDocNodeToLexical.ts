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

import { LexicalDocNode } from "../lexicalDocNode.js";
import {
  getIsApplyingOwnChanges,
  setIsApplyingOwnChanges,
} from "../syncLexicalToDocNode.js";
import type { KeyBinding } from "../types.js";
import { transformSelection } from "./transformSelection.js";

export function syncDocNodeToLexical(
  doc: Doc,
  editor: LexicalEditor,
  keyBinding: KeyBinding,
) {
  const unregisterDocListener = doc.onChange(({ operations }) => {
    if (getIsApplyingOwnChanges(editor)) {
      return;
    }

    setIsApplyingOwnChanges(editor, true);

    try {
      editor.update(
        () => {
          applyDocNodeOperations(doc, operations, keyBinding);
        },
        { discrete: true, skipTransforms: true, tag: COLLABORATION_TAG },
      );
    } finally {
      setIsApplyingOwnChanges(editor, false);
    }
  });

  return unregisterDocListener;
}

function applyDocNodeOperations(
  doc: Doc,
  operations: Operations,
  keyBinding: KeyBinding,
) {
  const { lexicalKeyToDocNodeId, docNodeIdToLexicalKey } = keyBinding;
  const [orderedOps, statePatch] = operations;
  const lexicalRoot = $getRoot();

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

  const createLexicalNodes = (docNodeIds: string[]): LexicalNode[] => {
    const nodes: LexicalNode[] = [];

    for (const docNodeId of docNodeIds) {
      const docNode = doc.getNodeById(docNodeId);
      if (!docNode?.is(LexicalDocNode)) {
        continue;
      }

      const serialized = docNode.state.j.get();
      const lexicalNode = $parseSerializedNode(serialized);
      const lexicalKey = lexicalNode.getKey();
      lexicalKeyToDocNodeId.set(lexicalKey, docNodeId);
      docNodeIdToLexicalKey.set(docNodeId, lexicalKey);
      nodes.push(lexicalNode);
    }

    return nodes;
  };

  for (const op of orderedOps) {
    switch (op[0]) {
      case 0: {
        const [, nodeInfos, parentId, prevId, nextId] = op;
        const nodeIds = nodeInfos.map(([id]) => id);
        const lexicalNodes = createLexicalNodes(nodeIds);

        if (prevId !== 0) {
          const prevNode = getLexicalNode(prevId);
          if (prevNode) {
            let insertAfter = prevNode;
            lexicalNodes.forEach((node) => {
              insertAfter.insertAfter(node);
              insertAfter = node;
            });
          }
        } else if (nextId !== 0) {
          const nextNode = getLexicalNode(nextId);
          if (nextNode) {
            lexicalNodes.reverse().forEach((node) => {
              nextNode.insertBefore(node);
            });
          }
        } else {
          const parent = getLexicalNode(parentId);
          if (parent && $isElementNode(parent)) {
            parent.append(...lexicalNodes);
          }
        }
        break;
      }

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

        if (endId === 0) {
          lexicalKeyToDocNodeId.delete(startKey);
          docNodeIdToLexicalKey.delete(startId);
          startNode.remove();
        } else {
          const endKey = docNodeIdToLexicalKey.get(endId);
          if (!endKey) {
            break;
          }

          const nodesToDelete: NodeKey[] = [startKey];
          let current = startNode.getNextSibling();
          while (current && current.getKey() !== endKey) {
            nodesToDelete.push(current.getKey());
            current = current.getNextSibling();
          }
          if (current) {
            nodesToDelete.push(endKey);
          }

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
    transformSelection(lexicalNode, serialized);
    lexicalNode.getWritable().updateFromJSON(serialized);
  }
}
