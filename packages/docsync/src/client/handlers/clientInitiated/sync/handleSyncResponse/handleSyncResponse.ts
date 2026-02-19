/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncRequest } from "../../../../../shared/types.js";
import type { DocSyncClient } from "../../../../index.js";
import { applyAndBroadcastServerOps } from "./applyAndBroadcastServerOps.js";
import type { BuildSyncPayloadResult } from "../buildSyncPayload.js";
import { persistDocDeleted } from "./persistDocDeleted.js";
import {
  type SyncResponseData,
  persistSyncResult,
} from "./persistSyncResult.js";

/**
 * Handles a successful sync response: emits the sync event, then either
 * persists a "deleted" doc or persists the sync result and optionally
 * applies and broadcasts server operations.
 */
export async function handleSyncResponse<
  D extends {},
  S extends {},
  O extends {},
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  payload: SyncRequest<O>,
  req: BuildSyncPayloadResult<O>["req"],
  operationsBatches: O[][],
  data: SyncResponseData<S, O>,
): Promise<void> {
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
    await persistDocDeleted(client, docId, data.clock);
    const entry = client["_docsCache"].get(docId);
    if (entry) {
      client["_docsCache"].set(docId, {
        ...entry,
        promisedDoc: Promise.resolve("deleted"),
      });
    }
    return;
  }

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

  const serverOps = data.operations ?? [];
  if (didConsolidate && serverOps.length > 0)
    await applyAndBroadcastServerOps(client, docId, serverOps);
}
