import { defineNode, defineState, Doc, type DocConfig } from "@docukit/docnode";
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

export const createLexicalDoc = (): Doc => {
  return Doc.fromJSON(
    { type: "root", extensions: [{ nodes: [LexicalDocNode] }] },
    ["01kc52hq510g6y44jhq0wqrjb3", "root", {}],
  );
};
