/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncResponse } from "../../../../shared/types.js";
import type { DocSyncClient } from "../../../index.js";
import { request } from "../../../utils/request.js";
import { applyAndBroadcastServerOps } from "./applyAndBroadcastServerOps.js";
import { buildSyncPayload } from "./buildSyncPayload.js";
import { persistDocDeleted } from "./persistDocDeleted.js";
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

  // Serialize pushes: if a push is already in progress, mark that another one is
  // pending and return; the pending sync will run after the current one finishes.
  const status = cacheEntry.pushStatus;
  if (status !== "idle") {
    cacheEntry.pushStatus = "pushing-with-pending";
    return;
  }
  cacheEntry.pushStatus = "pushing";

  // Build the sync payload (clock, operations or serialized doc) and send request.
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

  // Success: emit sync event with server data (operations, serializedDoc, clock).
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

  if (data.serializedDoc === "deleted") {
    // Server says doc is deleted: persist deletion and resolve cache to "deleted".
    await persistDocDeleted(client, docId, data.clock);
    const entry = client["_docsCache"].get(docId);
    if (entry) {
      client["_docsCache"].set(docId, {
        ...entry,
        promisedDoc: Promise.resolve("deleted"),
      });
    }
  } else {
    // Normal sync: persist server result and optionally apply server ops locally.
    if (payload.operations === "deleted")
      throw new Error(
        "If client sends 'deleted', server should respond with 'deleted' too",
      );
    const didConsolidate = await persistSyncResult(
      client,
      docId,
      data,
      operationsBatches,
      payload.operations ?? [],
    );

    // If we consolidated and server sent new ops, apply them and broadcast to listeners.
    const persistedServerOperations = data.operations ?? [];
    if (didConsolidate && persistedServerOperations.length > 0) {
      await applyAndBroadcastServerOps(
        client,
        docId,
        persistedServerOperations,
      );
    }
  }

  // Reset push status; if another sync was queued (pushing-with-pending), run it now.
  const currentEntry = client["_docsCache"].get(docId);
  if (currentEntry) {
    const shouldRetry = currentEntry.pushStatus === "pushing-with-pending";
    currentEntry.pushStatus = "idle";
    if (shouldRetry) {
      void handleSync(client, docId);
    }
  }
};
