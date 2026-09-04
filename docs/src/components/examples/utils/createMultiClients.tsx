"use client";

import { DocNodeBinding } from "@docukit/docsync-react/docnode";
import {
  indexedDBProvider,
  createDocSyncClient,
} from "@docukit/docsync-react/client";
import type { DocConfig } from "@docukit/docnode";
import { env } from "@/env";

// Create 3 separate DocSyncClient instances with different deviceIds
const createClientForUser = (
  userId: string,
  deviceId: string,
  docConfigs: DocConfig[],
) => {
  // This demo fakes several users inside a single browser origin, which DocSync
  // does not support on its own: it keeps one local identity per origin, so the
  // first client to be authenticated would make every later client claim that
  // same user and the server would reject the mismatched ones. Pinning both
  // keys before constructing each client keeps every synthetic user claiming
  // the user its token actually authenticates as. Real applications have one
  // user per origin and never need this.
  if (typeof window !== "undefined") {
    localStorage.setItem("docsync:deviceId", deviceId);
    localStorage.setItem("docsync:localUserId", userId);
  }

  return createDocSyncClient({
    server: {
      url: env.NEXT_PUBLIC_DOCSYNC_SERVER_URL,
      auth: {
        mode: "token",
        getToken: () => userId, // Use userId as token
      },
    },
    local: { provider: indexedDBProvider },
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
