"use client";

import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import {
  IndexedDBProvider,
  createDocSyncClient,
} from "@docnode/docsync-react/client";
import type { DocConfig } from "docnode";

// Create 3 separate DocSyncClient instances with different deviceIds
const createClientForUser = (
  userId: string,
  deviceId: string,
  docConfigs: DocConfig[],
) => {
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
    docBinding: DocNodeBinding(docConfigs),
  });
};

export function createMultiClients(docConfigs: DocConfig[]) {
  // Reference client (user1, device A)
  const { useDoc: useReferenceDoc, client: referenceClient } =
    createClientForUser("user1", "device-a", docConfigs);

  // Other tab client (user1, device A - same device as reference)
  const { useDoc: useOtherTabDoc, client: otherTabClient } =
    createClientForUser("user1", "device-a", docConfigs);

  // Other device client (user2, device B - different device)
  const { useDoc: useOtherDeviceDoc, client: otherDeviceClient } =
    createClientForUser("user2", "device-b", docConfigs);

  return {
    useReferenceDoc,
    referenceClient,
    useOtherTabDoc,
    otherTabClient,
    useOtherDeviceDoc,
    otherDeviceClient,
  };
}
