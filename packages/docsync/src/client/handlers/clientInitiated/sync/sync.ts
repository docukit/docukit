import type { SyncRequest, SyncResponse } from "../../../../shared/types.js";
import { withSyncLock } from "../../../../shared/withSyncLock.js";
import type { DocSyncCore } from "../../../core.js";
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

/**
 * What a sync attempt was started for. It stays valid while the connection it
 * was sent on is still the current one and the document is still the same
 * loaded instance. Once either changes, the attempt has nothing left to report
 * to: the query was already paused or removed, and a newer attempt may own the
 * document on the new connection.
 */
type SyncAttemptToken = { generation: number; cacheEntry: object };

type SyncAttemptOutcome =
  | { type: "synced" }
  | { type: "stale" }
  | { type: "failed"; error: DocSyncError; transient: boolean };

function isLiveSyncAttempt<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncCore<D, S, O>,
  docId: string,
  token: SyncAttemptToken,
): boolean {
  return (
    client["_connectionGeneration"] === token.generation &&
    client["_docsCache"].get(docId) === token.cacheEntry
  );
}

/** Applies server operations to the cached doc. */
async function applyServerOperations<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncCore<D, S, O>,
  args: { docId: string; operations: O[]; isLive: () => boolean },
): Promise<void> {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry || !args.isLive()) return;

  const doc = await cacheEntry.promisedDoc;
  if (!doc || !args.isLive()) return;

  for (const op of args.operations) {
    client["_applyOperationsFrom"]("network", doc, op, { skipUndo: true });
  }
}

function replaceDocInCache<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncCore<D, S, O>,
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
  // The entry itself is kept: it identifies the loaded document for the sync
  // attempt that is replacing its doc, and for any subscriber holding it.
  cacheEntry.promisedDoc = nextPromisedDoc;

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
  client: DocSyncCore<D, S, O>,
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
  client: DocSyncCore<D, S, O>,
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
  client: DocSyncCore<D, S, O>,
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
  client: DocSyncCore<D, S, O>,
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
 * One request/response round trip for a document: push the operations saved
 * locally, receive what the server has since the local clock, and reconcile
 * both into IndexedDB and the live doc. Flow control lives in `handleSync`.
 */
async function runSyncAttempt<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncCore<D, S, O>,
  docId: string,
  token: SyncAttemptToken,
  signal: AbortSignal,
): Promise<SyncAttemptOutcome> {
  const isLive = () => isLiveSyncAttempt(client, docId, token);
  const stale: SyncAttemptOutcome = { type: "stale" };

  // The connection or loaded document may have changed while waiting for
  // another tab. A superseded attempt must not flush, send or write.
  if (!isLive()) return stale;

  await client.flush(docId);
  if (!isLive()) return stale;
  const requestLocalVersion = getLocalDocVersion(client, docId);

  const { provider } = await client["_localPromise"];
  if (!isLive()) return stale;

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
  if (!isLive()) return stale;
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return stale;
  const operations = operationsBatches.flat();
  const req: SyncRequest<S, O> = {
    type: cacheEntry.type,
    clock: stored?.clock ?? 0,
    docId,
    operations,
    serializedDoc: stored?.serializedDoc ?? null,
  };

  let response: SyncResponse<S, O>;
  try {
    response = await request(client["_socket"], "sync", req, undefined, signal);
  } catch (error) {
    if (!isLive()) return stale;
    const queryError = new DocSyncError(
      "NetworkError",
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
    client["_events"].emit("sync", {
      req,
      error: { type: "NetworkError", message: queryError.message },
    });
    return { type: "failed", error: queryError, transient: true };
  }
  if (!isLive()) return stale;

  if ("error" in response && response.error) {
    client["_events"].emit("sync", { req, error: response.error });
    // Only a DatabaseError is transient. Authorization and validation
    // failures would be rejected identically on every retry, so retrying
    // them is a loop that can never converge.
    return {
      type: "failed",
      error: new DocSyncError(response.error.type, response.error.message),
      transient: response.error.type === "DatabaseError",
    };
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
  if (!isLive()) return stale;
  const preparedReconciliation = await prepareSyncReconciliation(client, {
    provider,
    docId,
    operationsBatches,
    localOperations: operations,
    data,
    isCurrent: isLive,
  });
  if (!isLive()) return stale;

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
      isLive,
    });
    if (!isLive()) return stale;
    broadcastServerOperations(client, {
      docId,
      operations: reconcileResult.operations,
    });
  }
  return { type: "synced" };
}

/**
 * Syncs a document with the server, one attempt at a time per document.
 *
 * A sync requested while another is in flight never starts a second request:
 * it marks the running one to go again once it finishes, so the follow-up
 * carries every operation saved in the meantime. Retries after a transient
 * failure are scheduled the same way. This single rule is what keeps two
 * attempts from reading the same pending operations and pushing them twice.
 */
export const handleSync = async <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncCore<D, S, O>,
  docId: string,
): Promise<void> => {
  if (!client["_socket"].connected) return;

  const syncDebounceState = client["_syncDebounceState"].get(docId);
  clearTimeout(syncDebounceState?.timeout);
  client["_syncDebounceState"].delete(docId);

  const queue = client["_syncQueue"];
  const running = queue.get(docId);
  // A running attempt that is still live takes the request as a rerun. One
  // that is not, because the document was reloaded or the connection changed,
  // can only exit; the request gets an attempt of its own.
  if (running && isLiveSyncAttempt(client, docId, running.token)) {
    running.rerun = true;
    return;
  }
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;

  cancelPendingSyncRetry(client, docId);
  const token: SyncAttemptToken = {
    generation: client["_connectionGeneration"],
    cacheEntry,
  };
  const slot = { rerun: false, token, controller: new AbortController() };
  queue.set(docId, slot);
  const release = () => {
    if (queue.get(docId) === slot) queue.delete(docId);
  };
  const isLive = () => isLiveSyncAttempt(client, docId, token);

  let outcome: SyncAttemptOutcome | { type: "retrying" };
  try {
    do {
      slot.rerun = false;
      const { identity } = await client["_localPromise"];
      outcome = await withSyncLock(identity.userId, docId, () =>
        runSyncAttempt(client, docId, token, slot.controller.signal),
      );
      if (
        outcome.type === "failed" &&
        outcome.transient &&
        scheduleSyncRetry(client, docId, () => {
          void handleSync(client, docId);
        })
      ) {
        // The scheduled retry absorbs any sync queued during the failed
        // request: it will read the same pending operations when it fires.
        outcome = { type: "retrying" };
      }
    } while (
      slot.rerun &&
      isLive() &&
      (outcome.type === "synced" || outcome.type === "failed")
    );
  } catch (error) {
    // A provider or binding failure. Free the document so later syncs can run,
    // report it on the query unless a queued sync is about to replace the
    // result anyway, and rethrow so the failure stays loud: callers use
    // `void handleSync(...)`, so it surfaces as an unhandled rejection, which
    // is what a provider or binding bug has to be.
    release();
    if (isLive()) {
      if (slot.rerun) {
        void handleSync(client, docId);
      } else {
        try {
          dispatchNetworkQueryError(
            client,
            docId,
            error instanceof Error ? error : new Error(String(error)),
          );
        } catch {
          // Reporting the failure must never replace the failure itself.
        }
      }
    }
    throw error;
  }

  // Release before dispatching: a listener may start the next sync, and it
  // needs its own slot rather than a rerun flag on one that is being dropped.
  release();
  if (!isLive()) return;

  if (outcome.type === "failed") {
    dispatchNetworkQueryError(client, docId, outcome.error);
    return;
  }
  if (outcome.type !== "synced") return;

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
};
