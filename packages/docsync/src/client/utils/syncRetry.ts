import type { DocSyncClient } from "../index.js";

/**
 * Transient sync failures (network drops, a server database hiccup) are worth
 * retrying, but retrying them immediately turns an outage into a hot loop that
 * hammers the server for as long as it stays down. Back off exponentially up to
 * a fixed ceiling, then give up, leaving the error visible on the query so the
 * application can decide what to do.
 *
 * The attempts below span 300, 600, 1200, 2400, 4800 and then 5000ms three
 * times — roughly 24 seconds, long enough to ride out a server restart without
 * retrying a genuinely broken document forever.
 *
 * The budget covers one episode of failure, not the document's whole lifetime:
 * a successful sync, a reconnect, and exhausting the budget all reset it, so a
 * later edit gets its own bounded chain. Keeping a spent counter around would
 * be cheaper in requests — a document that burned its budget would never retry
 * again while the socket stays up — but that is the worse failure mode: the
 * document stops recovering on its own for the rest of the connection, and the
 * user has no way to ask it to try again beyond reloading.
 */
const SYNC_RETRY_BASE_DELAY = 300;
const SYNC_RETRY_MAX_DELAY = 5_000;
const SYNC_RETRY_MAX_ATTEMPTS = 8;

export type SyncRetryState = {
  attempts: number;
  timeout?: ReturnType<typeof setTimeout>;
};

/**
 * Schedules `retry` with exponential backoff. Returns whether a retry was
 * scheduled: `false` means the document exhausted its attempts, so the caller
 * must settle the query instead of leaving it looking busy.
 */
export function scheduleSyncRetry<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string, retry: () => void): boolean {
  const retryStates = client["_syncRetryState"];
  const previousState = retryStates.get(docId);
  const attempts = (previousState?.attempts ?? 0) + 1;
  if (attempts > SYNC_RETRY_MAX_ATTEMPTS) {
    // Forget the spent budget instead of leaving it at the ceiling. Nothing is
    // scheduled here, so the caller still settles the query and this cannot
    // loop; it only means the next failure — from a user edit, a `dirty`
    // event, or a reconnect — starts its own chain.
    clearSyncRetry(client, docId);
    return false;
  }

  const delay = Math.min(
    SYNC_RETRY_BASE_DELAY * 2 ** (attempts - 1),
    SYNC_RETRY_MAX_DELAY,
  );
  const nextState: SyncRetryState = { attempts };
  nextState.timeout = setTimeout(() => {
    // A manual sync or a newer failure may have replaced this backoff. Only
    // the timer still stored for the document is allowed to start a request.
    if (retryStates.get(docId) !== nextState) return;
    delete nextState.timeout;
    retry();
  }, delay);
  retryStates.set(docId, nextState);
  return true;
}

/** Cancels a pending timer without resetting how far backoff has progressed. */
export function cancelPendingSyncRetry<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string): void {
  const retryState = client["_syncRetryState"].get(docId);
  if (!retryState?.timeout) return;
  clearTimeout(retryState.timeout);
  delete retryState.timeout;
}

/** Forgets the backoff for a document, so the next failure starts over. */
export function clearSyncRetry<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string): void {
  const retryState = client["_syncRetryState"].get(docId);
  if (!retryState) return;
  clearTimeout(retryState.timeout);
  client["_syncRetryState"].delete(docId);
}

/** Forgets every pending backoff, e.g. when the connection drops. */
export function clearAllSyncRetries<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>): void {
  for (const retryState of client["_syncRetryState"].values()) {
    clearTimeout(retryState.timeout);
  }
  client["_syncRetryState"].clear();
}
