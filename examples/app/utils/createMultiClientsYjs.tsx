"use client";

import { YjsBinding } from "@docukit/docsync-react/yjs";
import {
  IndexedDBProvider,
  createDocSyncClient,
} from "@docukit/docsync-react/client";

// Create 3 separate DocSyncClient instances with different deviceIds
const createClientForUser = (userId: string, deviceId: string) => {
  // Force specific deviceId in localStorage before creating client
  if (typeof window !== "undefined") {
    localStorage.setItem("docsync:deviceId", deviceId);
  }

  return createDocSyncClient({
    server: {
      url: "ws://localhost:8082",
      auth: {
        getToken: () => userId, // Use userId as token
      },
    },
    local: {
      provider: IndexedDBProvider,
      getIdentity: () => ({ userId, secret: "asdasdasd" }),
    },
    docBinding: YjsBinding(),
  });
};

export function createMultiClientsYjs() {
  // Reference client (user1, device A)
  const {
    useDoc: useReferenceDoc,
    usePresence: useReferencePresence,
    client: referenceClient,
  } = createClientForUser("user1", "device-a");

  // Other tab client (user1, device A - same device as reference)
  const {
    useDoc: useOtherTabDoc,
    usePresence: useOtherTabPresence,
    client: otherTabClient,
  } = createClientForUser("user1", "device-a");

  // Other device client (user2, device B - different device)
  const {
    useDoc: useOtherDeviceDoc,
    usePresence: useOtherDevicePresence,
    client: otherDeviceClient,
  } = createClientForUser("user2", "device-b");

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
