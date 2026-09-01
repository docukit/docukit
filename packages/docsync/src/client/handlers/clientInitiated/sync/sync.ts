import type { SyncRequest, SyncResponse } from "../../../../shared/types.js";
import type { DocSyncClient } from "../../../index.js";
import {
  dispatchLocalDocFound,
  dispatchNetworkDocFound,
  dispatchNetworkDocNotFound,
} from "../../../utils/dispatchDocQueryAction.js";
import { getOwnPresencePatch } from "../../../utils/getOwnPresencePatch.js";
import { getLocalDocVersion } from "../../../utils/localDocVersion.js";
import { request } from "../../../utils/request.js";
import { setupDocChangeListener } from "../../../utils/setupDocChangeListener.js";
import { reconcileSyncResponse } from "./reconcileSyncResponse.js";

/** Applies server operations to the cached doc. */
async function applyServerOperations<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; operations: O[] },
): Promise<void> {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;

  const doc = await cacheEntry.promisedDoc;
  if (!doc) return;

  for (const op of args.operations) {
    client["_applyOperationsFrom"]("network", doc, op, { skipUndo: true });
  }
}

function replaceDocInCache<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: {
    docId: string;
    doc: D;
    exportedHistory?: { promisedDoc: Promise<D | undefined>; value: unknown };
  },
): void {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;

  const previousPromisedDoc = cacheEntry.promisedDoc;
  const nextPromisedDoc = Promise.resolve(args.doc);
  const docBinding = client["_docBinding"];
  if (
    args.exportedHistory?.promisedDoc === previousPromisedDoc &&
    docBinding.importHistory
  ) {
    docBinding.importHistory(args.doc, args.exportedHistory.value);
  }
  setupDocChangeListener(client, args);

  client["_docsCache"].set(args.docId, {
    promisedDoc: nextPromisedDoc,
    refCount: cacheEntry.refCount,
    localVersion: cacheEntry.localVersion,
    type: cacheEntry.type,
    ...(cacheEntry.localLoadMode && {
      localLoadMode: cacheEntry.localLoadMode,
    }),
    queryResult: cacheEntry.queryResult,
    queryListeners: cacheEntry.queryListeners,
    presence: cacheEntry.presence,
    presenceListeners: cacheEntry.presenceListeners,
  });

  void previousPromisedDoc
    .then((previousDoc) => {
      const currentEntry = client["_docsCache"].get(args.docId);
      if (
        currentEntry?.promisedDoc === nextPromisedDoc &&
        previousDoc &&
        previousDoc !== args.doc
      ) {
        client["_docBinding"].dispose(previousDoc);
      }
    })
    .catch(() => undefined);
}

async function exportHistoryForPotentialReplacement<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: {
    docId: string;
    hasServerSnapshot: boolean;
    hasConcurrentOperations: boolean;
  },
): Promise<
  { promisedDoc: Promise<D | undefined>; value: unknown } | undefined
> {
  if (!args.hasServerSnapshot && !args.hasConcurrentOperations) return;
  const docBinding = client["_docBinding"];
  if (!docBinding.exportHistory) return;
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;
  const doc = await cacheEntry.promisedDoc;
  if (!doc) return;
  return {
    promisedDoc: cacheEntry.promisedDoc,
    value: docBinding.exportHistory(doc),
  };
}

function broadcastServerOperations<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; operations: O[] },
): void {
  const presence = getOwnPresencePatch(client, args.docId);
  for (const op of args.operations) {
    client["_bcHelper"]?.broadcast({
      type: "OPERATIONS",
      source: "network",
      operations: op,
      docId: args.docId,
      flags: {},
      presence,
    });
  }
}

/**
 * Sync (push) a document to the server. Queues if already pushing (sets
 * pushing-with-pending), otherwise sets pushing and runs the sync.
 */
export const handleSync = async <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
): Promise<void> => {
  if (!client["_socket"].connected) return;

  const syncDebounceState = client["_syncDebounceState"].get(docId);
  clearTimeout(syncDebounceState?.timeout);
  client["_syncDebounceState"].delete(docId);

  const pushStatusByDocId = client["_pushStatusByDocId"];
  const status = pushStatusByDocId.get(docId) ?? "idle";
  if (status !== "idle") {
    pushStatusByDocId.set(docId, "pushing-with-pending");
    return;
  }
  pushStatusByDocId.set(docId, "pushing");

  if (client["_localOpsBatchState"].has(docId)) {
    await client["_flushLocalOperations"](docId, { sync: false });
  }
  const requestLocalVersion = getLocalDocVersion(client, docId);

  const { provider } = await client["_localPromise"];
  const socket = client["_socket"];

  // Prepare payload: read operations and clock from provider.
  const [operationsBatches, stored] = await provider.transaction(
    "readonly",
    async (ctx) => {
      return Promise.all([
        ctx.getOperations({ docId }),
        ctx.getSerializedDoc({ docId }),
      ]);
    },
  );
  const operations = operationsBatches.flat();
  const clientClock = stored?.clock ?? 0;

  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) {
    // Doc was unloaded while this sync was in-flight — abort.
    pushStatusByDocId.set(docId, "idle");
    return;
  }
  const type = cacheEntry.type;
  const payload: SyncRequest<S, O> = {
    type,
    clock: clientClock,
    docId,
    operations,
    serializedDoc: stored?.serializedDoc ?? null,
  };
  const req = payload;

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
    pushStatusByDocId.set(docId, "idle");
    void handleSync(client, docId);
    return;
  }

  if ("error" in response && response.error) {
    client["_events"].emit("sync", { req, error: response.error });
    pushStatusByDocId.set(docId, "idle");
    void handleSync(client, docId);
    return;
  }

  const { data } = response;
  client["_events"].emit("sync", { req, data });

  // Replacement is required when the server supplies a snapshot or when
  // concurrent operations are order-sensitive. Capture ephemeral history
  // before reconciliation so DocNode's export can commit any pending edit and
  // reconciliation can include that edit in the replacement document.
  const exportedHistory = await exportHistoryForPotentialReplacement(client, {
    docId,
    hasServerSnapshot: data.serializedDoc !== null,
    hasConcurrentOperations:
      data.operations.length > 0 && operations.length > 0,
  });

  const reconcileResult = await reconcileSyncResponse(client, {
    provider,
    docId,
    operationsBatches,
    localOperations: operations,
    requestLocalVersion,
    data,
  });

  if (reconcileResult.type === "replaceDoc") {
    replaceDocInCache(client, {
      docId,
      doc: reconcileResult.doc,
      ...(exportedHistory && { exportedHistory }),
    });
    dispatchLocalDocFound(client, docId, { doc: reconcileResult.doc, docId });
    broadcastServerOperations(client, { docId, operations: data.operations });
  } else if (reconcileResult.type === "applyServerOperations") {
    await applyServerOperations(client, {
      docId,
      operations: reconcileResult.operations,
    });
    broadcastServerOperations(client, {
      docId,
      operations: reconcileResult.operations,
    });
  }

  const currentStatus = pushStatusByDocId.get(docId);
  const shouldRetry = currentStatus === "pushing-with-pending";
  pushStatusByDocId.set(docId, "idle");
  if (shouldRetry) {
    void handleSync(client, docId);
    return;
  }
  const latestCacheEntry = client["_docsCache"].get(docId);
  if (!latestCacheEntry) return;
  if (latestCacheEntry.queryResult.fetchStatus === "idle") return;

  if (
    latestCacheEntry.queryResult.status === "success" &&
    latestCacheEntry.queryResult.data !== undefined
  ) {
    dispatchNetworkDocFound(client, docId, latestCacheEntry.queryResult.data);
    return;
  }

  dispatchNetworkDocNotFound(client, docId, {
    createIfMissing: latestCacheEntry.localLoadMode === "loadOrCreate",
  });
};
