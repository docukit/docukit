"use client";

import {
  DocSyncClientProvider,
  IndexedDBProvider,
} from "@docnode/docsync-react/client";
import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import { type DocBinding } from "@docnode/docsync-react";
import { type ReactNode } from "react";
import {
  defineNode,
  type Doc,
  type DocConfig,
  type Operations,
  string,
} from "docnode";

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
    <DocSyncClientProvider
      config={{
        url: "ws://localhost:8081",
        local: {
          provider: IndexedDBProvider,
          getIdentity: async () => ({
            userId: "John Salchichon",
            secret: "asdasdasd",
          }),
        },
        auth: {
          getToken: async () => "1234567890" as string,
        },
        // undoManagerSize: 50
        // TODO: fix this
        docBinding: DocNodeBinding([IndexDocConfig]) as unknown as DocBinding<
          NonNullable<unknown>,
          Array<unknown>,
          Operations
        >,
      }}
    >
      {children}
    </DocSyncClientProvider>
  );
}
