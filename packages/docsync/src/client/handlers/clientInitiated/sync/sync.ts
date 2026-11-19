import type {
  SubscriptionData,
  SyncRequest,
  SyncResponse,
} from "../../../../shared/types.js";
import type { DocSyncClient } from "../../../index.js";
import type { ClientProvider, OperationsBatch } from "../../../types.js";
import {
  dispatchLocalDocFound,
  dispatchNetworkDocFound,
  dispatchNetworkDocNotFound,
  dispatchNetworkQueryError,
} from "../../../utils/dispatchDocQueryAction.js";
import { DocSyncError } from "../../../utils/DocSyncError.js";
import {
  type DocStream,
  announceStoredBatches,
  catchUpLiveDoc,
  getLiveClock,
  inStreamOrder,
  isStreaming,
  receiveOwnBatch,
  restartDocStream,
  setLiveClock,
  startDocStream,
} from "../../../utils/docStream.js";
import {
  exportHistoryFromCurrentSource,
  replaceDocInCache,
  resolveHistorySourceForPotentialReplacement,
  resolvePendingMemoryOperations,
} from "../../../utils/liveDoc.js";
import { getLocalDocVersion } from "../../../utils/localDocVersion.js";
import { request } from "../../../utils/request.js";
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
  client: DocSyncClient<D, S, O>,
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
  client: DocSyncClient<D, S, O>,
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

/**
 * One request/response round trip for a document. The first on a connection
 * subscribes: it sends the operations saved locally with the local clock,
 * receives what the server has since, and reconciles both into IndexedDB and
 * the live doc. Later ones only send operations, because the server pushes
 * every other batch (see `docStream.ts`). Flow control lives in `handleSync`.
 */
async function runSyncAttempt<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  token: SyncAttemptToken,
): Promise<SyncAttemptOutcome> {
  const isLive = () => isLiveSyncAttempt(client, docId, token);
  const stale: SyncAttemptOutcome = { type: "stale" };

  if (client["_localOpsBatchState"].has(docId)) {
    await client["_flushLocalOperations"](docId, { sync: false });
  }
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
  const operations = operationsBatches.flatMap((batch) => batch.operations);

  // Another tab or worker can save the doc after the initial local load.
  // Advertising that stored clock to the server is only safe once the missing
  // live doc has also been loaded: an up-to-date server sends no snapshot.
  if (stored) {
    const promisedDoc = cacheEntry.promisedDoc;
    const liveDoc = await promisedDoc;
    if (!isLive()) return stale;
    if (!liveDoc && cacheEntry.promisedDoc === promisedDoc) {
      const doc = client["_docBinding"].deserialize(stored.serializedDoc);
      for (const operation of operations) {
        client["_docBinding"].applyOperations(doc, operation, {
          skipUndo: true,
        });
      }
      setLiveClock(client, doc, stored.clock);
      replaceDocInCache(client, { docId, doc });
      dispatchLocalDocFound(client, docId, { doc, docId });
      if (!isLive()) return stale;
    }
  }

  let subscribed = isStreaming(client, cacheEntry.stream);
  // Subscribed and nothing to send: the server pushes everything else.
  if (subscribed && operationsBatches.length === 0) return { type: "synced" };
  const clock = stored?.clock ?? 0;
  // Syncs send operations, not the whole doc. A subscription sends the doc
  // only while the local copy is still at clock 0, because no operation of it
  // has reached the server yet, or when the server asks for it because it
  // lost its copy. A subscribed sync never sends it.
  let req: SyncRequest<S, O> = subscribed
    ? { docId, operations }
    : {
        type: cacheEntry.type,
        clock,
        docId,
        operations,
        serializedDoc: clock === 0 ? (stored?.serializedDoc ?? null) : null,
      };

  let response: SyncResponse<S, O>;
  try {
    response = await request(client["_socket"], "sync", req);
    if (stored && response.data && "needsSerializedDoc" in response.data) {
      if (!isLive()) return stale;
      // The server lost its copy and saved nothing: subscribe again with ours.
      subscribed = false;
      req = {
        type: cacheEntry.type,
        clock: stored.clock,
        docId,
        operations,
        serializedDoc: stored.serializedDoc,
      };
      response = await request(client["_socket"], "sync", req);
    }
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

  const { data } = response;
  // Still synchronous since the response arrived: a batch pushed right after
  // it has not been numbered yet.
  if (subscribed) {
    const stream = cacheEntry.stream;
    if (!isStreaming(client, stream)) return stale;
    clearSyncRetry(client, docId);
    client["_events"].emit("sync", { req, data });
    const expected = stream.clock + (operations.length > 0 ? 1 : 0);
    if (data.clock !== expected) {
      restartDocStream(client, docId);
      return {
        type: "failed",
        error: new DocSyncError(
          "ValidationError",
          `Expected clock ${expected} from the server, got ${data.clock}: the server provider must number the batches of a document one by one`,
        ),
        transient: false,
      };
    }
    await receiveOwnBatch(client, {
      docId,
      stream,
      clock: data.clock,
      operations,
      ids: operationsBatches.map((batch) => batch.id),
    });
    return isLive() ? { type: "synced" } : stale;
  }
  if (!("operations" in data)) {
    return {
      type: "failed",
      error: new DocSyncError(
        "ValidationError",
        "The server answered a subscription with a bare clock",
      ),
      transient: false,
    };
  }
  const stream = startDocStream(client, docId, {
    generation: token.generation,
    clock: data.clock,
  });
  if (!stream) return stale;
  clearSyncRetry(client, docId);
  client["_events"].emit("sync", { req, data });
  return inStreamOrder(stream, () =>
    reconcileSubscription(client, {
      docId,
      token,
      stream,
      provider,
      operationsBatches,
      operations,
      requestLocalVersion,
      requestClock: req.clock ?? 0,
      data,
    }),
  );
}

/**
 * Reconciles the response to a subscription into IndexedDB and the live doc,
 * in the stream's order: batches pushed after it wait until it is done.
 */
async function reconcileSubscription<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: {
    docId: string;
    token: SyncAttemptToken;
    stream: DocStream<O>;
    provider: ClientProvider<S, O>;
    operationsBatches: OperationsBatch<O>[];
    operations: O[];
    requestLocalVersion: number;
    requestClock: number;
    data: SubscriptionData<S, O>;
  },
): Promise<SyncAttemptOutcome> {
  const {
    docId,
    token,
    stream,
    provider,
    operationsBatches,
    operations,
    requestLocalVersion,
    requestClock,
    data,
  } = args;
  const isLive = () => isLiveSyncAttempt(client, docId, token);
  const stale: SyncAttemptOutcome = { type: "stale" };
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry || !isLive()) return stale;

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
  if (preparedReconciliation.didConsolidate) {
    announceStoredBatches(client, { docId, clock: data.clock });
  }
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
  const liveDocBefore = historySource?.doc;
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
    setLiveClock(client, reconcileResult.doc, data.clock);
    const replaceResult = replaceDocInCache(client, {
      docId,
      doc: reconcileResult.doc,
      ...(exportedHistory && { exportedHistory }),
    });
    dispatchLocalDocFound(client, docId, { doc: reconcileResult.doc, docId });
    // IndexedDB was already reconciled before the history import. Finish the
    // cache swap first so persistent and visible content cannot diverge, then
    // keep the binding failure loud for the caller.
    if (replaceResult) throw replaceResult.historyImportError;
  } else {
    const liveDoc = liveDocBefore ?? (await cacheEntry.promisedDoc);
    // The response holds everything after the request's clock. Applied on a
    // live doc at that clock, or with nothing to apply, the live doc ends at
    // the response's clock; otherwise the catch-up below rebuilds it.
    const isAtRequestClock =
      liveDoc !== undefined && getLiveClock(client, liveDoc) === requestClock;
    if (reconcileResult.type === "applyServerOperations") {
      await applyServerOperations(client, {
        docId,
        operations: reconcileResult.operations,
        isLive,
      });
      if (!isLive()) return stale;
    }
    if (
      liveDoc &&
      isAtRequestClock &&
      (reconcileResult.type === "applyServerOperations" ||
        data.operations.length === 0)
    ) {
      setLiveClock(client, liveDoc, data.clock);
    }
  }
  await catchUpLiveDoc(client, { docId, stream, clock: data.clock });
  return isLive() ? { type: "synced" } : stale;
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
  client: DocSyncClient<D, S, O>,
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
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const slot = { rerun: false, token, settled };
  queue.set(docId, slot);
  const release = () => {
    if (queue.get(docId) === slot) queue.delete(docId);
    settle();
  };
  const isLive = () => isLiveSyncAttempt(client, docId, token);

  let outcome: SyncAttemptOutcome | { type: "retrying" };
  try {
    do {
      slot.rerun = false;
      outcome = await runSyncAttempt(client, docId, token);
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
