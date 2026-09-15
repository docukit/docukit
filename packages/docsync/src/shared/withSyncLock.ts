/** Keep the store read, request and reconciliation in one cross-tab turn. */
export function withSyncLock<T>(
  userId: string,
  docId: string,
  sync: () => Promise<T>,
) {
  if (typeof navigator === "undefined" || !navigator.locks) return sync();
  return navigator.locks.request(
    `docsync:sync:${JSON.stringify([userId, docId])}`,
    sync,
  );
}
