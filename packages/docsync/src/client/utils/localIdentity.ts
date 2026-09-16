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
  const [storedDeviceId, userId] = await Promise.all([
    tx.store.get("deviceId"),
    tx.store.get("userId"),
  ]);
  const deviceId = storedDeviceId ?? crypto.randomUUID();
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
  await db.delete("metadata", "userId");
};
