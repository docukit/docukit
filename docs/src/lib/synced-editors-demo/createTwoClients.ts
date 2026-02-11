"use client";

import { DocNodeBinding } from "@docukit/docsync-react/docnode";
import {
  IndexedDBProvider,
  createDocSyncClient,
} from "@docukit/docsync-react/client";
import type { DocConfig } from "@docukit/docnode";

/**
 * Clears all content from the demo IndexedDB. Call before creating the DocSync
 * client so each page load starts with a clean local state.
 */
export function clearDemoIndexedDB(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase("docsync-user1");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(new Error(req.error?.message));
  });
}

function createClient(
  userId: string,
  deviceId: string,
  docConfigs: DocConfig[],
) {
  if (typeof window !== "undefined") {
    localStorage.setItem("docsync:deviceId", deviceId);
  }
  return createDocSyncClient({
    server: {
      url: "ws://non-existent-url.com",
      auth: { getToken: async () => userId },
    },
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({ userId, secret: "docs-demo" }),
    },
    docBinding: DocNodeBinding(docConfigs),
  });
}

export function createTwoClients(docConfigs: DocConfig[]) {
  const {
    useDoc: useEditor1Doc,
    usePresence: useEditor1Presence,
    client: editor1Client,
  } = createClient("user1", "device-a", docConfigs);

  editor1Client?.disconnect();

  const {
    useDoc: useEditor2Doc,
    usePresence: useEditor2Presence,
    client: editor2Client,
  } = createClient("user1", "device-a", docConfigs);

  editor2Client?.disconnect();

  return {
    useEditor1Doc,
    useEditor1Presence,
    editor1Client,
    useEditor2Doc,
    useEditor2Presence,
    editor2Client,
  };
}
