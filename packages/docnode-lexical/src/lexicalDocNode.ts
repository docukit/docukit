import { defineNode, defineState, type DocConfig } from "@docukit/docnode";
import type { SerializedLexicalNode, SerializedRootNode } from "lexical";

const defaultSerializedRoot: SerializedRootNode = {
  children: [],
  direction: null,
  format: "",
  indent: 0,
  type: "root",
  version: 1,
};

const lexicalRootState = defineState({
  fromJSON: (json) => (json ?? defaultSerializedRoot) as SerializedRootNode,
});

export const LexicalDocNode = defineNode({
  type: "l",
  state: {
    j: defineState({
      fromJSON: (json) =>
        (json ?? {}) as SerializedLexicalNode & { [key: string]: unknown },
    }),
  },
});

export function createLexicalDocRootNode<T extends string>(type: T) {
  return defineNode({ type, state: { j: lexicalRootState } });
}

export const LexicalDocRootNode = createLexicalDocRootNode("docnode-lexical");

export function createLexicalDocNodeConfig(
  config?: Omit<Partial<DocConfig>, "extensions">,
): DocConfig {
  const type = config?.type ?? LexicalDocRootNode.type;

  return {
    ...config,
    type,
    extensions: [{ nodes: [LexicalDocNode, createLexicalDocRootNode(type)] }],
  };
}
