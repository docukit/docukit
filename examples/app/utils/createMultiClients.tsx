"use client";

import { DocNodeBinding } from "@docukit/docsync-react/docnode";
import {
  IndexedDBProvider,
  createDocSyncClient,
} from "@docukit/docsync-react/client";
import type { DocConfig } from "@docukit/docnode";

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
      getIdentity: async () => ({ userId, secret: "asdasdasd" }),
    },
    docBinding: DocNodeBinding(docConfigs),
  });
};

export function createMultiClients(docConfigs: DocConfig[]) {
  // Reference client (user1, device A)
  const {
    useDoc: useReferenceDoc,
    usePresence: useReferencePresence,
    client: referenceClient,
  } = createClientForUser("user1", "device-a", docConfigs);

  // Other tab client (user1, device A - same device as reference)
  const {
    useDoc: useOtherTabDoc,
    usePresence: useOtherTabPresence,
    client: otherTabClient,
  } = createClientForUser("user1", "device-a", docConfigs);

  // Other device client (user2, device B - different device)
  const {
    useDoc: useOtherDeviceDoc,
    usePresence: useOtherDevicePresence,
    client: otherDeviceClient,
  } = createClientForUser("user2", "device-b", docConfigs);

  return {
    useReferenceDoc,
    useReferencePresence,
    referenceClient,
    useOtherTabDoc,
    useOtherTabPresence,
    otherTabClient,
    useOtherDeviceDoc,
    useOtherDevicePresence,
    otherDeviceClient,
  };
}
