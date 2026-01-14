"use client";

import { createDocSyncClient } from "@docnode/docsync-react/client";
import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import { IndexedDBProvider } from "@docnode/docsync-react/client";
import { defineNode, string, type DocConfig, type Doc } from "docnode";
import { useEffect, useState } from "react";

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

// Create 3 separate DocSyncClient instances
const createClientForUser = (userId: string, deviceId?: string) => {
  // Force different deviceId for "other device"
  if (deviceId && typeof window !== "undefined") {
    localStorage.setItem("docsync:deviceId", deviceId);
  }

  return createDocSyncClient({
    server: {
      url: "ws://localhost:8081",
      auth: {
        getToken: async () => "1234567890" as string,
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

// Reference client (user1)
export const {
  DocSyncClientProvider: ReferenceDocSyncClientProvider,
  useDoc: useReferenceDoc,
} = createClientForUser("user1");

// Other tab client (user1, same device)
export const {
  DocSyncClientProvider: OtherTabDocSyncClientProvider,
  useDoc: useOtherTabDoc,
} = createClientForUser("user1");

// Other device client (user2, different device)
let otherDeviceClientSetup: ReturnType<typeof createClientForUser> | undefined;

export function OtherDeviceDocSyncClientProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isReady, setIsReady] = useState(false);
  const [Provider, setProvider] =
    useState<React.ComponentType<{ children: React.ReactNode }>>();

  useEffect(() => {
    // Wait a bit to ensure other clients have initialized their deviceIds
    setTimeout(() => {
      const newDeviceId = crypto.randomUUID();
      otherDeviceClientSetup = createClientForUser("user2", newDeviceId);
      setProvider(() => otherDeviceClientSetup!.DocSyncClientProvider);
      setIsReady(true);
    }, 100);
  }, []);

  if (!isReady || !Provider) {
    return <div className="text-zinc-500">Initializing...</div>;
  }

  return <Provider>{children}</Provider>;
}

// Wrapper that matches useReferenceDoc signature exactly
export const useOtherDeviceDoc = ((
  args: Parameters<typeof useReferenceDoc>[0],
) => {
  if (!otherDeviceClientSetup) {
    throw new Error("Other device client not initialized");
  }
  return otherDeviceClientSetup.useDoc(args);
}) as typeof useReferenceDoc;
