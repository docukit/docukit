import type { DocSyncClient } from "../index.js";
import { request } from "./request.js";

export const unsubscribeDoc = async <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
): Promise<void> => {
  if (!client["_socket"].connected) return;

  try {
    await request(client["_socket"], "unsubscribe-doc", { docId });
  } catch {
    // Cleanup should not surface transient disconnects or timeout failures.
  }
};
