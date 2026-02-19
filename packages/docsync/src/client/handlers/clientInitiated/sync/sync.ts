/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncResponse } from "../../../../shared/types.js";
import type { DocSyncClient } from "../../../index.js";
import { request } from "../../../utils/request.js";
import { buildSyncPayload } from "./buildSyncPayload.js";
import { handleSyncResponse } from "./handleSyncResponse.js";

/**
 * Sync (push) a document to the server. Queues if already pushing (sets
 * pushing-with-pending), otherwise sets pushing and runs the sync.
 */
export const handleSync = async <D extends {}, S extends {}, O extends {}>(
  client: DocSyncClient<D, S, O>,
  docId: string,
): Promise<void> => {
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

  let response: SyncResponse<S, O>;
  try {
    response = await request(client["_socket"], "sync", payload);
  } catch (error) {
    // Network failure: emit error, reset status, and retry sync once.
    client["_events"].emit("sync", {
      req,
      error: {
        type: "NetworkError",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    cacheEntry.pushStatus = "idle";
    void handleSync(client, docId);
    return;
  }

  // Server returned an application error (e.g. validation); emit and retry.
  if ("error" in response && response.error) {
    client["_events"].emit("sync", { req, error: response.error });
    cacheEntry.pushStatus = "idle";
    void handleSync(client, docId);
    return;
  }

  await handleSyncResponse(
    client,
    docId,
    payload,
    req,
    operationsBatches,
    response.data,
  );

  const current = client["_docsCache"].get(docId);
  if (current) {
    const retry = current.pushStatus === "pushing-with-pending";
    current.pushStatus = "idle";
    if (retry) void handleSync(client, docId);
  }
};
