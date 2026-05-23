import { defineNode, defineState, type DocConfig } from "@docukit/docnode";
import type { SerializedLexicalNode } from "lexical";

export const LexicalDocNode = defineNode({
  type: "l",
  state: {
    j: defineState({
      fromJSON: (json) =>
        (json ?? {}) as SerializedLexicalNode & { [key: string]: unknown },
    }),
  },
});

export const lexicalDocNodeConfig: DocConfig = {
  type: "docnode-lexical",
  extensions: [{ nodes: [LexicalDocNode] }],
};
