"use client";

import { DocNodeBinding } from "@docukit/docsync-react/docnode";
import {
  indexedDBProvider,
  createDocSyncClient,
} from "@docukit/docsync-react/client";
import { useEffect, useState } from "react";
import type { DocConfig } from "@docukit/docnode";
import { env } from "@/env";

// The demo simulates installations that normally live in separate origins.
const seedDemoIdentity = (userId: string, deviceId: string) =>
  new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open("docsync:metadata", 1);
    opening.onupgradeneeded = () =>
      opening.result.createObjectStore("metadata");
    opening.onerror = () =>
      reject(opening.error ?? new Error("Metadata database failed to open"));
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction("metadata", "readwrite");
      const store = tx.objectStore("metadata");
      store.put(userId, "userId");
      store.put(deviceId, "deviceId");
      store.put("true", "migrated");
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error("Metadata transaction aborted"));
      };
    };
  });

const createClientForUser = async (
  userId: string,
  deviceId: string,
  docConfigs: DocConfig[],
) => {
  await seedDemoIdentity(userId, deviceId);
  const result = createDocSyncClient({
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
  await result.client?.["_localPromise"];
  return result;
};

async function initializeMultiClients(docConfigs: DocConfig[]) {
  // Reference client (user1, device A)
  const {
    useDoc: useReferenceDoc,
    usePresence: useReferencePresence,
    client: referenceClient,
  } = await createClientForUser("user1", "device-a", docConfigs);

  // Other tab client (user1, device A - same device as reference)
  const {
    useDoc: useOtherTabDoc,
    usePresence: useOtherTabPresence,
    client: otherTabClient,
  } = await createClientForUser("user1", "device-a", docConfigs);

  // Other device client (user2, device B - different device)
  const {
    useDoc: useOtherDeviceDoc,
    usePresence: useOtherDevicePresence,
    client: otherDeviceClient,
  } = await createClientForUser("user2", "device-b", docConfigs);

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

export function createMultiClients(docConfigs: DocConfig[]) {
  let pending: ReturnType<typeof initializeMultiClients> | undefined;
  return function useClients() {
    const [state, setState] = useState(
      (): {
        clients?: Awaited<ReturnType<typeof initializeMultiClients>>;
        error?: Error;
      } => ({}),
    );
    useEffect(() => {
      // Capture each synthetic identity before another example can replace it.
      pending ??= Promise.resolve(
        navigator.locks.request("docsync:demo-initialization", () =>
          initializeMultiClients(docConfigs),
        ),
      );
      void pending.then(
        (clients) => setState({ clients }),
        (error: unknown) =>
          setState({
            error: error instanceof Error ? error : new Error(String(error)),
          }),
      );
    }, []);
    if (state.error) throw state.error;
    return state.clients;
  };
}
