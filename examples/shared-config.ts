import { defineNode, string, type DocConfig } from "docnode";

// Shared node definition for both client and server
export const IndexNode = defineNode({
  type: "editor-index",
  state: {
    value: string(""),
  },
});

// Shared doc configuration
export const IndexDocConfig: DocConfig = {
  type: "indexDoc",
  extensions: [{ nodes: [IndexNode] }],
  nodeIdGenerator: "ulid",
};
