import type { DocSyncClient } from "../index.js";

/**
 * Transient sync failures (network drops, a server database hiccup) are worth
 * retrying, but retrying them immediately turns an outage into a hot loop that
 * hammers the server for as long as it stays down. Back off exponentially and
 * give up after a handful of attempts, leaving the error visible on the query
 * so the application can decide what to do.
 */
const SYNC_RETRY_BASE_DELAY = 300;
const SYNC_RETRY_MAX_DELAY = 5_000;
const SYNC_RETRY_MAX_ATTEMPTS = 5;

export type SyncRetryState = {
  attempts: number;
  timeout?: ReturnType<typeof setTimeout>;
};

/**
 * Schedules `retry` with exponential backoff. Returns `false` once the document
 * has exhausted its attempts, so the caller can stop retrying.
 */
export function scheduleSyncRetry<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string, retry: () => void): boolean {
  const retryStates = client["_syncRetryState"];
  const attempts = (retryStates.get(docId)?.attempts ?? 0) + 1;
  if (attempts > SYNC_RETRY_MAX_ATTEMPTS) return false;

  const delay = Math.min(
    SYNC_RETRY_BASE_DELAY * 2 ** (attempts - 1),
    SYNC_RETRY_MAX_DELAY,
  );
  const timeout = setTimeout(() => {
    delete retryStates.get(docId)?.timeout;
    retry();
  }, delay);
  retryStates.set(docId, { attempts, timeout });
  return true;
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
