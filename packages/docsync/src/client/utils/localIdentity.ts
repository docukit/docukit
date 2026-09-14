import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Identity } from "../types.js";

interface MetadataDB extends DBSchema {
  metadata: { key: string; value: string };
}

let database: Promise<IDBPDatabase<MetadataDB>> | undefined;

const openMetadata = () => {
  database ??= openDB("docsync:metadata", 1, {
    upgrade(db) {
      db.createObjectStore("metadata");
    },
  });
  return database;
};

/** One transaction gives concurrently starting tabs and workers the same ID. */
export const readLocalMetadata = async () => {
  const db = await openMetadata();
  const tx = db.transaction("metadata", "readwrite");
  const [storedDeviceId, storedUserId, migrated] = await Promise.all([
    tx.store.get("deviceId"),
    tx.store.get("userId"),
    tx.store.get("migrated"),
  ]);
  let deviceId = storedDeviceId;
  let userId = storedUserId;

  // Only migration needs a Window API. Afterward both environments use IDB.
  // A worker cannot migrate a previous installation: start the page client
  // before its worker on that installation's first run after upgrading.
  if (!migrated && typeof localStorage !== "undefined") {
    deviceId ??= localStorage.getItem("docsync:deviceId") ?? undefined;
    userId ??= localStorage.getItem("docsync:localUserId") ?? undefined;
    if (userId) await tx.store.put(userId, "userId");
    await tx.store.put("true", "migrated");
  }

  deviceId ??= crypto.randomUUID();
  if (deviceId !== storedDeviceId) await tx.store.put(deviceId, "deviceId");
  await tx.done;
  return { deviceId, identity: userId ? { userId } : undefined };
};

export const saveLocalIdentity = async (identity: Identity) => {
  const db = await openMetadata();
  await db.put("metadata", identity.userId, "userId");
};

export const clearLocalIdentity = async () => {
  const db = await openMetadata();
  const tx = db.transaction("metadata", "readwrite");
  await tx.store.delete("userId");
  // A later Window must not restore a cleared identity from legacy storage.
  await tx.store.put("true", "migrated");
  await tx.done;
};
