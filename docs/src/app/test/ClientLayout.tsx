"use client";

import {
  DocNodeClientProvider,
  IndexedDBProvider,
} from "@docnode/sync-react/client";
import { type ReactNode } from "react";
import { defineNode, type Doc, type DocConfig, string } from "docnode";

export const IndexNode = defineNode({
  type: "editor-index",
  state: {
    value: string(""),
    // TODO: fromJSON and toJSON should have jsdocs
    // asd: {
    //   fromJSON: (json) => json,
    // }
  },
});

const IndexDocConfig: DocConfig = {
  namespace: "indexDoc",
  extensions: [{ nodes: [IndexNode] }],
  nodeIdGenerator: "ulid",
};

export function createIndexNode(doc: Doc, { value }: { value: string }) {
  const node = doc.createNode(IndexNode);
  node.state.value.set(value);
  return node;
}

export default function ClientLayout({ children }: { children: ReactNode }) {
  return (
    <DocNodeClientProvider
      config={{
        url: "ws://localhost:8081",
        local: {
          provider: IndexedDBProvider,
          getSecret: async () => "asdasdasd",
        },
        auth: {
          getToken: async () => "1234567890",
        },
        // undoManagerSize: 50, // by default is 0
        docConfigs: [IndexDocConfig],
      }}
    >
      {children}
    </DocNodeClientProvider>
  );
}
