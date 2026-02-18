/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncRequest, SyncResponse } from "../../../shared/types.js";
import type { DocSyncClient } from "../../index.js";
import { getOwnPresencePatch } from "../../utils/getOwnPresencePatch.js";
import { request } from "../../utils/request.js";

/** Applies server operations to the cached doc and emits change event (remote). */
export async function applyServerOperations<
  D extends {},
  S extends {},
  O extends {},
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; operations: O[] },
): Promise<void> {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;

  const doc = await cacheEntry.promisedDoc;
  if (!doc || doc === "deleted") return;

  client["_shouldBroadcast"] = false;
  for (const op of args.operations) {
    client["_docBinding"].applyOperations(doc, op);
  }
  client["_shouldBroadcast"] = true;

  client["_events"].emit("change", {
    docId: args.docId,
    origin: "remote",
    operations: args.operations,
  });
}

/**
 * Replaces the cached document (e.g. when server responds with a squashed doc).
 * Keeps refCount, presence, and presenceListeners unchanged.
 */
export async function replaceDocInCache<
  D extends {},
  S extends {},
  O extends {},
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; doc?: D; serializedDoc?: S },
): Promise<void> {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;
  if (args.doc === undefined && args.serializedDoc === undefined) return;

  const newDoc =
    args.doc ?? client["_docBinding"].deserialize(args.serializedDoc!);

  client["_docsCache"].set(args.docId, {
    promisedDoc: Promise.resolve(newDoc),
    refCount: cacheEntry.refCount,
    presence: cacheEntry.presence,
    presenceListeners: cacheEntry.presenceListeners,
    pushStatus: cacheEntry.pushStatus,
    localOpsBatchState: cacheEntry.localOpsBatchState,
    presenceDebounceState: cacheEntry.presenceDebounceState,
  });
}

/**
 * Sync (push) a document to the server. Queues if already pushing (sets
 * pushing-with-pending), otherwise sets pushing and runs the sync.
 */
export const handleSync = async <D extends {}, S extends {}, O extends {}>(
  client: DocSyncClient<D, S, O>,
  docId: string,
): Promise<void> => {
  const cacheEntry = client["_docsCache"].get(docId);
  const status = cacheEntry?.pushStatus ?? "idle";
  if (status !== "idle") {
    if (cacheEntry) cacheEntry.pushStatus = "pushing-with-pending";
    return;
  }
  if (cacheEntry) cacheEntry.pushStatus = "pushing";

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

  const isDeleteMarker =
    operationsBatches === "deleted" || stored?.serializedDoc === "deleted";
  if (isDeleteMarker) {
    const clientClock = stored?.clock ?? 0;
    const req = { docId, operations: [] as O[], clock: clientClock };
    const success = false;
    try {
      // success = await handleDeleteDoc(client["_socket"], { docId });
    } catch (error) {
      client["_events"].emit("sync", {
        req,
        error: {
          type: "NetworkError",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      if (cacheEntry) cacheEntry.pushStatus = "idle";
      void handleSync(client, docId);
      return;
    }
    if (!success) {
      client["_events"].emit("sync", {
        req,
        error: { type: "DatabaseError", message: "Delete doc failed" },
      });
      if (cacheEntry) cacheEntry.pushStatus = "idle";
      void handleSync(client, docId);
      return;
    }
    await provider.transaction("readwrite", async (ctx) => {
      const ops = await ctx.getOperations({ docId });
      const count = ops === "deleted" ? 1 : ops.length;
      if (count > 0) await ctx.deleteOperations({ docId, count });
      await ctx.saveSerializedDoc({
        serializedDoc: "deleted",
        docId,
        clock: clientClock,
      });
    });
    const currentEntry = client["_docsCache"].get(docId);
    if (currentEntry) {
      currentEntry.promisedDoc = Promise.resolve("deleted" as D | "deleted");
      const currentStatus = currentEntry.pushStatus;
      currentEntry.pushStatus = "idle";
      if (currentStatus === "pushing-with-pending") {
        void handleSync(client, docId);
      }
    }
    return;
  }

  const operations = operationsBatches.flat();
  const clientClock = stored?.clock ?? 0;

  const presenceState = cacheEntry?.presenceDebounceState;
  let presence: unknown;
  if (presenceState !== undefined) {
    clearTimeout(presenceState.timeout);
    presence = presenceState.data;
    if (cacheEntry) cacheEntry.presenceDebounceState = undefined;
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
    if (cacheEntry) cacheEntry.pushStatus = "idle";
    void handleSync(client, docId);
    return;
  }

  if ("error" in response && response.error) {
    client["_events"].emit("sync", { req, error: response.error });
    if (cacheEntry) cacheEntry.pushStatus = "idle";
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

    if (stored.serializedDoc === "deleted") return;

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

  const currentEntry = cacheEntry ?? client["_docsCache"].get(docId);
  if (currentEntry) {
    const currentStatus = currentEntry.pushStatus;
    const shouldRetry = currentStatus === "pushing-with-pending";
    currentEntry.pushStatus = "idle";
    if (shouldRetry) {
      void handleSync(client, docId);
    }
  }
};
