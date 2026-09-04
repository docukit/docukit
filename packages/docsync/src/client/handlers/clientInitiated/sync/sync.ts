import type { SyncRequest, SyncResponse } from "../../../../shared/types.js";
import type { DocSyncClient } from "../../../index.js";
import {
  dispatchLocalDocFound,
  dispatchNetworkDocFound,
  dispatchNetworkDocNotFound,
  dispatchNetworkQueryError,
} from "../../../utils/dispatchDocQueryAction.js";
import { DocSyncError } from "../../../utils/DocSyncError.js";
import { getOwnPresencePatch } from "../../../utils/getOwnPresencePatch.js";
import { getLocalDocVersion } from "../../../utils/localDocVersion.js";
import { request } from "../../../utils/request.js";
import { setupDocChangeListener } from "../../../utils/setupDocChangeListener.js";
import {
  cancelPendingSyncRetry,
  clearSyncRetry,
  scheduleSyncRetry,
} from "../../../utils/syncRetry.js";
import {
  finalizeSyncReconciliation,
  prepareSyncReconciliation,
} from "./reconcileSyncResponse.js";

/** Applies server operations to the cached doc. */
async function applyServerOperations<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; operations: O[]; syncAttempt: symbol },
): Promise<void> {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (cacheEntry?.activeSyncAttempt !== args.syncAttempt) return;

  const doc = await cacheEntry.promisedDoc;
  if (!doc) return;
  if (
    client["_docsCache"].get(args.docId)?.activeSyncAttempt !== args.syncAttempt
  )
    return;

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
) {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;

  const previousPromisedDoc = cacheEntry.promisedDoc;
  const nextPromisedDoc = Promise.resolve(args.doc);
  const docBinding = client["_docBinding"];
  let historyImportError: { historyImportError: unknown } | undefined;
  if (
    args.exportedHistory?.promisedDoc === previousPromisedDoc &&
    docBinding.importHistory
  ) {
    try {
      docBinding.importHistory(args.doc, args.exportedHistory.value);
    } catch (error) {
      historyImportError = { historyImportError: error };
    }
  }
  setupDocChangeListener(client, args);

  client["_docsCache"].set(args.docId, {
    promisedDoc: nextPromisedDoc,
    activeSyncAttempt: cacheEntry.activeSyncAttempt,
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

  return historyImportError;
}

type HistorySource<D extends object> = {
  doc: D;
  promisedDoc: Promise<D | undefined>;
};

async function resolveHistorySourceForPotentialReplacement<
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
): Promise<HistorySource<D> | undefined> {
  if (!args.hasServerSnapshot && !args.hasConcurrentOperations) return;
  const docBinding = client["_docBinding"];
  if (!docBinding.exportHistory) return;
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;
  const doc = await cacheEntry.promisedDoc;
  if (!doc) return;
  return { doc, promisedDoc: cacheEntry.promisedDoc };
}

function exportHistoryFromCurrentSource<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  source: HistorySource<D> | undefined,
): { promisedDoc: Promise<D | undefined>; value: unknown } | undefined {
  if (!source) return;
  const cacheEntry = client["_docsCache"].get(docId);
  const docBinding = client["_docBinding"];
  if (
    cacheEntry?.promisedDoc !== source.promisedDoc ||
    !docBinding.exportHistory
  )
    return;
  return {
    promisedDoc: source.promisedDoc,
    value: docBinding.exportHistory(source.doc),
  };
}

/**
 * Resolves the in-memory operations batch across the history export.
 *
 * `exportHistory` force-commits the live doc, which pushes the resulting
 * operation into the batch *and* can flush it in the same synchronous turn:
 * `_flushLocalOperations` deletes the batch entry before its first await, so
 * reading the batch only after the export would miss that operation. The
 * replacement doc would then be swapped in without an edit whose undo entry we
 * just exported. The flush keeps the array it took, and the push happens before
 * it, so the reference captured beforehand still holds the operation.
 */
function resolvePendingMemoryOperations<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  batchBeforeExport: O[] | undefined,
): O[] {
  const batchAfterExport = client["_localOpsBatchState"].get(docId)?.data;
  if (batchBeforeExport === undefined) return batchAfterExport ?? [];
  if (
    batchAfterExport === undefined ||
    batchAfterExport === batchBeforeExport
  ) {
    return batchBeforeExport;
  }
  return [...batchBeforeExport, ...batchAfterExport];
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

function isCurrentSyncAttempt<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string, syncAttempt: symbol): boolean {
  return client["_docsCache"].get(docId)?.activeSyncAttempt === syncAttempt;
}

/** Releases flow control only when this is still the newest sync attempt. */
function finishSyncAttempt<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string, syncAttempt: symbol): boolean {
  const cacheEntry = client["_docsCache"].get(docId);
  if (cacheEntry?.activeSyncAttempt !== syncAttempt) return false;
  cacheEntry.activeSyncAttempt = undefined;
  client["_pushStatusByDocId"].set(docId, "idle");
  return true;
}

function finishFailedSyncAttempt<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  syncAttempt: symbol,
  shouldRetry: boolean,
): { hasPendingSync: boolean; retrying: boolean } | undefined {
  const hasPendingSync =
    client["_pushStatusByDocId"].get(docId) === "pushing-with-pending";
  if (!finishSyncAttempt(client, docId, syncAttempt)) return;

  const retrying =
    shouldRetry &&
    scheduleSyncRetry(client, docId, () => {
      void handleSync(client, docId);
    });
  return { hasPendingSync, retrying };
}

/**
 * Reports a finished attempt once. A scheduled retry or a sync queued during
 * the failed request keeps the existing query result unchanged; the queued
 * sync starts here only when no retry already covers it.
 */
function reportFinishedSyncError<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  error: Error,
  continuation: { hasPendingSync: boolean; retrying: boolean },
): void {
  const { hasPendingSync, retrying } = continuation;
  try {
    if (!retrying && !hasPendingSync) {
      dispatchNetworkQueryError(client, docId, error);
    }
  } finally {
    if (
      hasPendingSync &&
      !retrying &&
      client["_pushStatusByDocId"].get(docId) === "idle"
    ) {
      void handleSync(client, docId);
    }
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
  const initialCacheEntry = client["_docsCache"].get(docId);
  if (!initialCacheEntry) {
    // The document was unloaded; a missing entry already reads as idle, and
    // nothing would ever delete an entry created here.
    pushStatusByDocId.delete(docId);
    return;
  }
  cancelPendingSyncRetry(client, docId);
  const syncAttempt = Symbol(docId);
  initialCacheEntry.activeSyncAttempt = syncAttempt;
  let didFinishSyncAttempt = false;
  // Any throw below would leave the push status stuck on "pushing", and every
  // later handleSync call would early-return on it — the document would stop
  // syncing until a reload. Reset the status and rethrow so the failure stays
  // loud.
  try {
    if (client["_localOpsBatchState"].has(docId)) {
      await client["_flushLocalOperations"](docId, { sync: false });
    }
    if (!isCurrentSyncAttempt(client, docId, syncAttempt)) return;
    const requestLocalVersion = getLocalDocVersion(client, docId);

    const { provider } = await client["_localPromise"];
    if (!isCurrentSyncAttempt(client, docId, syncAttempt)) return;
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
    if (!isCurrentSyncAttempt(client, docId, syncAttempt)) return;
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
      if (!isCurrentSyncAttempt(client, docId, syncAttempt)) return;
      const queryError = new DocSyncError(
        "NetworkError",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
      client["_events"].emit("sync", {
        req,
        error: { type: "NetworkError", message: queryError.message },
      });
      if (!isCurrentSyncAttempt(client, docId, syncAttempt)) return;
      const continuation = finishFailedSyncAttempt(
        client,
        docId,
        syncAttempt,
        true,
      );
      if (!continuation) return;
      didFinishSyncAttempt = true;
      reportFinishedSyncError(client, docId, queryError, continuation);
      return;
    }

    if (!isCurrentSyncAttempt(client, docId, syncAttempt)) return;

    if ("error" in response && response.error) {
      client["_events"].emit("sync", { req, error: response.error });
      if (!isCurrentSyncAttempt(client, docId, syncAttempt)) return;
      const queryError = new DocSyncError(
        response.error.type,
        response.error.message,
      );
      // Only a DatabaseError is transient. Authorization and validation
      // failures would be rejected identically on every retry, so retrying
      // them is a loop that can never converge.
      const continuation = finishFailedSyncAttempt(
        client,
        docId,
        syncAttempt,
        response.error.type === "DatabaseError",
      );
      if (!continuation) return;
      didFinishSyncAttempt = true;
      reportFinishedSyncError(client, docId, queryError, continuation);
      return;
    }

    clearSyncRetry(client, docId);
    const { data } = response;
    client["_events"].emit("sync", { req, data });

    // Resolve the live doc before starting the asynchronous provider work. The
    // history itself is exported only in the synchronous final section below.
    const historySource = await resolveHistorySourceForPotentialReplacement(
      client,
      {
        docId,
        hasServerSnapshot: data.serializedDoc !== null,
        hasConcurrentOperations:
          data.operations.length > 0 && operations.length > 0,
      },
    );
    if (!isCurrentSyncAttempt(client, docId, syncAttempt)) return;
    const preparedReconciliation = await prepareSyncReconciliation(client, {
      provider,
      docId,
      operationsBatches,
      localOperations: operations,
      data,
      isCurrent: () => isCurrentSyncAttempt(client, docId, syncAttempt),
    });
    if (!isCurrentSyncAttempt(client, docId, syncAttempt)) return;

    // Keep this section synchronous. Exporting DocNode history force-commits a
    // pending edit, finalize then applies that operation to the replacement,
    // and replacement imports the matching history before another user event
    // can run.
    const batchBeforeExport = client["_localOpsBatchState"].get(docId)?.data;
    const exportedHistory =
      preparedReconciliation.replacementDoc &&
      preparedReconciliation.shouldReplaceDoc
        ? exportHistoryFromCurrentSource(client, docId, historySource)
        : undefined;
    const reconcileResult = finalizeSyncReconciliation(client, {
      docId,
      prepared: preparedReconciliation,
      requestLocalVersion,
      pendingMemoryOperations: resolvePendingMemoryOperations(
        client,
        docId,
        batchBeforeExport,
      ),
    });

    if (reconcileResult.type === "replaceDoc") {
      const replaceResult = replaceDocInCache(client, {
        docId,
        doc: reconcileResult.doc,
        ...(exportedHistory && { exportedHistory }),
      });
      dispatchLocalDocFound(client, docId, { doc: reconcileResult.doc, docId });
      broadcastServerOperations(client, { docId, operations: data.operations });
      // IndexedDB was already reconciled before the history import. Finish the
      // cache swap first so persistent and visible content cannot diverge, then
      // keep the binding failure loud for the caller.
      if (replaceResult) throw replaceResult.historyImportError;
    } else if (reconcileResult.type === "applyServerOperations") {
      await applyServerOperations(client, {
        docId,
        operations: reconcileResult.operations,
        syncAttempt,
      });
      if (!isCurrentSyncAttempt(client, docId, syncAttempt)) return;
      broadcastServerOperations(client, {
        docId,
        operations: reconcileResult.operations,
      });
    }

    const currentStatus = pushStatusByDocId.get(docId);
    const shouldRetry = currentStatus === "pushing-with-pending";
    if (!finishSyncAttempt(client, docId, syncAttempt)) return;
    didFinishSyncAttempt = true;
    if (shouldRetry) {
      void handleSync(client, docId);
      return;
    }
    const latestCacheEntry = client["_docsCache"].get(docId);
    if (!latestCacheEntry) return;

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
  } catch (error) {
    if (didFinishSyncAttempt) throw error;
    const hasPendingSync =
      pushStatusByDocId.get(docId) === "pushing-with-pending";
    // A superseded attempt loses the right to report on the query — a newer
    // attempt owns it now — but not the failure itself, which is just as real
    // whichever attempt hit it. So it skips the dispatch and still rethrows,
    // exactly like the current attempt does below. Callers use
    // `void handleSync(...)`, so both paths surface as an unhandled rejection:
    // loud in the console, and a failing test under Vitest, which is what a
    // provider or binding bug has to be.
    if (!finishSyncAttempt(client, docId, syncAttempt)) throw error;
    if (!hasPendingSync) {
      try {
        dispatchNetworkQueryError(
          client,
          docId,
          error instanceof Error ? error : new Error(String(error)),
        );
      } catch {
        // Reporting the failure on the query must never replace the failure
        // itself — the rethrow below is what keeps it loud.
      }
    }
    if (hasPendingSync && pushStatusByDocId.get(docId) === "idle") {
      void handleSync(client, docId);
    }
    throw error;
  }
};
