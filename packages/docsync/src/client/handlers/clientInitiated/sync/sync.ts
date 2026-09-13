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
import {
  exportHistoryFromCurrentSource,
  replaceDocInCache,
  resolveHistorySource,
  resolvePendingMemoryOperations,
} from "../../../utils/liveDoc.js";
import { getLocalDocVersion } from "../../../utils/localDocVersion.js";
import { request } from "../../../utils/request.js";
import {
  cancelPendingSyncRetry,
  clearSyncRetry,
  scheduleSyncRetry,
} from "../../../utils/syncRetry.js";
import { ensureSyncState } from "../../../utils/syncState.js";
import { reconcileSyncResponse } from "./reconcileSyncResponse.js";

/**
 * What a sync attempt was started for. It stays valid while the connection it
 * was sent on is still the current one, the document is still the same loaded
 * instance, and this tab still owns it. Once any of those changes, the attempt
 * has nothing left to report to: the query was paused or removed, or another
 * tab is syncing the document now.
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
  const cacheEntry = client["_docsCache"].get(docId);
  return (
    client["_connectionGeneration"] === token.generation &&
    cacheEntry === token.cacheEntry &&
    cacheEntry?.ownership.role === "owner"
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
 * One request/response round trip for a document: push the operations saved
 * locally, receive what the server has since the local clock, and reconcile
 * both into IndexedDB and the live doc. Flow control lives in `handleSync`.
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

  const state = await ensureSyncState(client, docId);
  if (!state || !isLive()) return stale;
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return stale;
  // Batches persisted while the request is out are appended to `pending`;
  // the count taken here is what the response acknowledges.
  const sentBatches = state.pending.length;
  const req: SyncRequest<S, O> = {
    type: cacheEntry.type,
    clock: state.clock,
    docId,
    operations: state.pending.flat(),
    serializedDoc: state.base ?? null,
  };

  let response: SyncResponse<S, O>;
  try {
    response = await request(client["_socket"], "sync", req);
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

  const docBinding = client["_docBinding"];
  const reconciled = reconcileSyncResponse(docBinding, {
    state,
    sentBatches,
    data,
  });
  if (!reconciled) return { type: "synced" };

  // Resolve the live doc before the asynchronous store write. The history
  // itself is exported only in the synchronous section below.
  const historySource = reconciled.shouldReplaceDoc
    ? await resolveHistorySource(client, docId)
    : undefined;
  if (!isLive()) {
    docBinding.dispose(reconciled.doc);
    return stale;
  }

  // The store follows the state: one write, no reads. Once the snapshot
  // write starts, the matching operation cleanup finishes in the same
  // transaction even if the connection drops, so the store can never hold a
  // snapshot that already contains batches still queued to be applied.
  const { provider } = await client["_localPromise"];
  await provider.transaction("readwrite", async (ctx) => {
    await ctx.saveSerializedDoc({
      docId,
      serializedDoc: reconciled.base,
      clock: reconciled.clock,
    });
    if (sentBatches > 0) {
      await ctx.deleteOperations({ docId, count: sentBatches });
    }
  });
  if (cacheEntry.syncState === state) {
    state.base = reconciled.base;
    state.clock = reconciled.clock;
    state.pending = state.pending.slice(sentBatches);
  }
  if (!isLive()) {
    docBinding.dispose(reconciled.doc);
    return stale;
  }

  // Keep this section synchronous. Exporting DocNode history force-commits a
  // pending edit, which the replacement then receives, and the replacement
  // imports the matching history before another user event can run.
  const batchBeforeExport = client["_localOpsBatchState"].get(docId)?.data;
  const exportedHistory = reconciled.shouldReplaceDoc
    ? exportHistoryFromCurrentSource(client, docId, historySource)
    : undefined;
  const pendingMemoryOperations = resolvePendingMemoryOperations(
    client,
    docId,
    batchBeforeExport,
  );
  const unsentOperations = state.pending.flat();
  // A live doc that changed without leaving operations behind, such as one
  // that applied another tab's broadcast, cannot be rebuilt from the state.
  const hasUnrebuildableLocalMemory =
    getLocalDocVersion(client, docId) > requestLocalVersion &&
    unsentOperations.length === 0 &&
    pendingMemoryOperations.length === 0;

  if (reconciled.shouldReplaceDoc && !hasUnrebuildableLocalMemory) {
    for (const operations of [
      ...unsentOperations,
      ...pendingMemoryOperations,
    ]) {
      docBinding.applyOperations(reconciled.doc, operations, {
        skipUndo: true,
      });
    }
    const replaceResult = replaceDocInCache(client, {
      docId,
      doc: reconciled.doc,
      ...(exportedHistory && { exportedHistory }),
    });
    dispatchLocalDocFound(client, docId, { doc: reconciled.doc, docId });
    broadcastServerOperations(client, { docId, operations: data.operations });
    // The store was already reconciled before the history import. Finish the
    // cache swap first so persistent and visible content cannot diverge, then
    // keep the binding failure loud for the caller.
    if (replaceResult) throw replaceResult.historyImportError;
  } else {
    docBinding.dispose(reconciled.doc);
    if (data.operations.length > 0) {
      await applyServerOperations(client, {
        docId,
        operations: data.operations,
        isLive,
      });
      if (!isLive()) return stale;
      broadcastServerOperations(client, { docId, operations: data.operations });
    }
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
  // Only the tab that owns the document syncs it; a mirror is kept current by
  // the owner's broadcasts.
  if (cacheEntry?.ownership.role !== "owner") return;

  cancelPendingSyncRetry(client, docId);
  const token: SyncAttemptToken = {
    generation: client["_connectionGeneration"],
    cacheEntry,
  };
  let finish: () => void = () => undefined;
  const slot = {
    rerun: false,
    token,
    done: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  };
  queue.set(docId, slot);
  const release = () => {
    if (queue.get(docId) === slot) queue.delete(docId);
    finish();
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
  const found =
    latestCacheEntry.queryResult.status === "success" &&
    latestCacheEntry.queryResult.data !== undefined;
  // The mirrors of this document settle their queries on the owner's syncs.
  client["_bcHelper"]?.broadcast({ type: "SYNCED", docId, found });
  if (latestCacheEntry.queryResult.data !== undefined) {
    dispatchNetworkDocFound(client, docId, latestCacheEntry.queryResult.data);
    return;
  }
  dispatchNetworkDocNotFound(client, docId, {
    createIfMissing: latestCacheEntry.localLoadMode === "loadOrCreate",
  });
};
