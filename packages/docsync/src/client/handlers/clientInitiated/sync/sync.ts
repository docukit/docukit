import type { DocSyncClient } from "../../../index.js";
import { buildSyncPayload } from "./buildSyncPayload.js";
import { handleSyncResponse } from "./handleSyncResponse/handleSyncResponse.js";

/**
 * Sync (push) a document to the server. Queues if already pushing (sets
 * pushing-with-pending), otherwise sets pushing and runs the sync.
 */
export const handleSync = async <D extends {}, S extends {}, O extends {}>(
  client: DocSyncClient<D, S, O>,
  docId: string,
): Promise<void> => {
  if (!client["_socket"].connected) return;

  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;

  // Serialize pushes: if a push is already in progress, mark that another one is
  // pending and return; the pending sync will run after the current one finishes.
  const status = cacheEntry.pushStatus;
  if (status !== "idle") {
    cacheEntry.pushStatus = "pushing-with-pending";
    return;
  }
  cacheEntry.pushStatus = "pushing";

  // Build the sync payload (clock, operations or serialized doc) and send request.
  const { payload, req, operationsBatches } = await buildSyncPayload(
    client,
    docId,
    cacheEntry,
  );

  const { error, data } = await client["_request"]("sync", payload);
  if (error) {
    client["_events"].emit("sync", { req, error });
    cacheEntry.pushStatus = "idle";
    void handleSync(client, docId);
    return;
  }

  if (data) {
    await handleSyncResponse(
      client,
      docId,
      payload,
      req,
      operationsBatches,
      data,
    );
  }

  const current = client["_docsCache"].get(docId);
  if (current) {
    const retry = current.pushStatus === "pushing-with-pending";
    current.pushStatus = "idle";
    if (retry) void handleSync(client, docId);
  }
};
