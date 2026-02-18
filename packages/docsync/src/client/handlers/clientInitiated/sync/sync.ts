/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncRequest, SyncResponse } from "../../../../shared/types.js";
import type { DocSyncClient } from "../../../index.js";
import { getOwnPresencePatch } from "../../../utils/getOwnPresencePatch.js";
import { request } from "../../../utils/request.js";

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

  const { provider } = await client["_localPromise"];
  const socket = client["_socket"];
  const docBinding = client["_docBinding"];

  // Prepare payload: read operations and clock from provider, flush presence debounce
  const [operationsBatches, stored] = await provider.transaction(
    "readonly",
    async (ctx) => {
      return Promise.all([
        ctx.getOperations({ docId }),
        ctx.getSerializedDoc(docId),
      ]);
    },
  );
  const operations = operationsBatches.flat();
  const clientClock = stored?.clock ?? 0;

  const presenceState = cacheEntry.presenceDebounceState;
  let presence: unknown;
  if (presenceState !== undefined) {
    clearTimeout(presenceState.timeout);
    presence = presenceState.data;
    cacheEntry.presenceDebounceState = undefined;
    client["_bcHelper"]?.broadcast({
      type: "PRESENCE",
      docId,
      presence: { [client["_clientId"]]: presence },
    });
  }
  const payload: SyncRequest<O> = {
    clock: clientClock,
    docId,
    operations,
    ...(presence !== undefined ? { presence } : {}),
  };
  const req = { docId, operations, clock: clientClock };

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
  let didConsolidate = false;

  await provider.transaction("readwrite", async (ctx) => {
    if (operationsBatches.length > 0) {
      await ctx.deleteOperations({ docId, count: operationsBatches.length });
    }

    const stored = await ctx.getSerializedDoc(docId);
    if (!stored) return;

    if (stored.clock >= data.clock) {
      didConsolidate = false;
      return;
    }

    const serverOps = data.operations ?? [];
    const allOps = [...serverOps, ...operations];
    if (allOps.length === 0) return;

    const doc = docBinding.deserialize(stored.serializedDoc);
    for (const op of allOps) {
      docBinding.applyOperations(doc, op);
    }
    const serializedDoc = docBinding.serialize(doc);

    const recheckStored = await ctx.getSerializedDoc(docId);
    if (recheckStored?.clock !== stored.clock) {
      return;
    }

    await ctx.saveSerializedDoc({ serializedDoc, docId, clock: data.clock });
    didConsolidate = true;
  });

  const persistedServerOperations = data.operations ?? [];
  if (didConsolidate && persistedServerOperations.length > 0) {
    await applyServerOperations(client, {
      docId,
      operations: persistedServerOperations,
    });

    const presencePatch = getOwnPresencePatch(client, docId);
    for (const op of persistedServerOperations) {
      client["_bcHelper"]?.broadcast({
        type: "OPERATIONS",
        operations: op,
        docId,
        ...(presencePatch && { presence: presencePatch }),
      });
    }
  }

  const currentEntry = client["_docsCache"].get(docId);
  if (currentEntry) {
    const currentStatus = currentEntry.pushStatus;
    const shouldRetry = currentStatus === "pushing-with-pending";
    currentEntry.pushStatus = "idle";
    if (shouldRetry) {
      void handleSync(client, docId);
    }
  }
};
