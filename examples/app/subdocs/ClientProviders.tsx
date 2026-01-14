"use client";

import { createDocSyncClient } from "@docnode/docsync-react/client";
import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import { IndexedDBProvider } from "@docnode/docsync-react/client";
import { defineNode, string, type DocConfig, type Doc } from "docnode";

// Same node definition as server
export const IndexNode = defineNode({
  type: "editor-index",
  state: {
    value: string(""),
  },
});

// Same doc configuration as server
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

// Create 3 separate DocSyncClient instances with different deviceIds
const createClientForUser = (userId: string, deviceId: string) => {
  // Force specific deviceId in localStorage before creating client
  if (typeof window !== "undefined") {
    localStorage.setItem("docsync:deviceId", deviceId);
  }

  return createDocSyncClient({
    server: {
      url: "ws://localhost:8081",
      auth: {
        getToken: async () => userId, // Use userId as token
      },
    },
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({
        userId,
        secret: "asdasdasd",
      }),
    },
    docBinding: DocNodeBinding([IndexDocConfig]),
  });
};

// Reference client (user1, device A)
export const { useDoc: useReferenceDoc } = createClientForUser(
  "user1",
  "device-a",
);

// Other tab client (user1, device A - same device as reference)
export const { useDoc: useOtherTabDoc } = createClientForUser(
  "user1",
  "device-a",
);

// Other device client (user2, device B - different device)
export const { useDoc: useOtherDeviceDoc } = createClientForUser(
  "user2",
  "device-b",
);
