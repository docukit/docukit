/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncResponse } from "../../../../shared/types.js";
import type { DocSyncClient } from "../../../index.js";
import { request } from "../../../utils/request.js";
import { applyAndBroadcastServerOps } from "./applyAndBroadcastServerOps.js";
import { buildSyncPayload } from "./buildSyncPayload.js";
import { persistSyncResult } from "./persistSyncResult.js";

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

  const status = cacheEntry.pushStatus;
  if (status !== "idle") {
    cacheEntry.pushStatus = "pushing-with-pending";
    return;
  }
  cacheEntry.pushStatus = "pushing";

  const socket = client["_socket"];
  const { payload, req, operationsBatches } = await buildSyncPayload(
    client,
    docId,
    cacheEntry,
  );

  let response: SyncResponse<S, O>;
  try {
    response = await request(socket, "sync", payload);
  } catch (error) {
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

  if ("error" in response && response.error) {
    client["_events"].emit("sync", { req, error: response.error });
    cacheEntry.pushStatus = "idle";
    void handleSync(client, docId);
    return;
  }

  const { data } = response;
  client["_events"].emit("sync", {
    req,
    data: {
      docId: data.docId,
      ...(data.operations ? { operations: data.operations } : {}),
      ...(data.serializedDoc ? { serializedDoc: data.serializedDoc } : {}),
      clock: data.clock,
    },
  });

  const operations =
    typeof payload.operations === "string" ? [] : (payload.operations ?? []);
  const didConsolidate = await persistSyncResult(
    client,
    docId,
    data,
    operationsBatches,
    operations,
  );

  const persistedServerOperations = data.operations ?? [];
  if (didConsolidate && persistedServerOperations.length > 0) {
    await applyAndBroadcastServerOps(client, docId, persistedServerOperations);
  }

  const currentEntry = client["_docsCache"].get(docId);
  if (currentEntry) {
    const shouldRetry = currentEntry.pushStatus === "pushing-with-pending";
    currentEntry.pushStatus = "idle";
    if (shouldRetry) {
      void handleSync(client, docId);
    }
  }
};
