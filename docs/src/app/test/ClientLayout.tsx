"use client";

import {
  createDocSyncClient,
  IndexedDBProvider,
} from "@docnode/docsync-react/client";
import { DocNodeBinding } from "@docnode/docsync-react/docnode";
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
  type: "indexDoc",
  extensions: [{ nodes: [IndexNode] }],
  nodeIdGenerator: "ulid",
};

export function createIndexNode(doc: Doc, { value }: { value: string }) {
  const node = doc.createNode(IndexNode);
  node.state.value.set(value);
  return node;
}

export const { DocSyncClientProvider, useDoc } = createDocSyncClient({
  url: "ws://localhost:8081",
  local: {
    provider: IndexedDBProvider,
    getIdentity: async () => ({
      userId: "John",
      secret: "asdasdasd",
    }),
  },
  auth: {
    getToken: async () => "1234567890" as string,
  },
  docBinding: DocNodeBinding([IndexDocConfig]),
  // undoManagerSize: 50
  // TODO: fix this
});

export default function ClientLayout({ children }: { children: ReactNode }) {
  return <DocSyncClientProvider>{children}</DocSyncClientProvider>;
}
