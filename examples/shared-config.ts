import { defineNode, string, type DocConfig, type Doc } from "docnode";

// Shared node definition for both client and server
export const IndexNode = defineNode({
  type: "editor-index",
  state: {
    value: string(""),
  },
});

// Helper function to create IndexNode
export function createIndexNode(doc: Doc, { value }: { value: string }) {
  const node = doc.createNode(IndexNode);
  node.state.value.set(value);
  return node;
}

// Shared doc configuration
export const indexDocConfig: DocConfig = {
  type: "indexDoc",
  extensions: [{ nodes: [IndexNode] }],
  nodeIdGenerator: "ulid",
};
