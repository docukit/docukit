"use client";

import {
  createDocSyncClient,
  IndexedDBProvider,
} from "@docnode/docsync-react/client";
import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import { type ReactNode } from "react";
import { type Doc } from "docnode";
import { IndexNode, IndexDocConfig } from "../../shared-config";

export { IndexNode };

export function createIndexNode(doc: Doc, { value }: { value: string }) {
  const node = doc.createNode(IndexNode);
  node.state.value.set(value);
  return node;
}

export const { DocSyncClientProvider, useDoc } = createDocSyncClient({
  server: {
    url: "ws://localhost:8081",
    auth: {
      getToken: async () => "1234567890" as string,
    },
  },
  local: {
    provider: IndexedDBProvider,
    getIdentity: async () => ({
      userId: "John",
      secret: "asdasdasd",
    }),
  },
  docBinding: DocNodeBinding([IndexDocConfig]),
  // undoManagerSize: 50
  // TODO: fix this
});

export default function ClientLayout({ children }: { children: ReactNode }) {
  return <DocSyncClientProvider>{children}</DocSyncClientProvider>;
}
