import type { DocSyncState } from "../handlers/clientInitiated/sync/reconcileSyncResponse.js";
import type { DocSyncClient } from "../index.js";

/**
 * Reads a document's sync state from the store. Used when the document is
 * loaded or taken over, and by a sync for a document that was registered
 * without loading it.
 */
export async function readSyncState<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string): Promise<DocSyncState<S, O>> {
  const { provider } = await client["_localPromise"];
  return provider.transaction("readonly", async (ctx) => {
    const stored = await ctx.getSerializedDoc({ docId });
    const pending = await ctx.getOperations({ docId });
    return { base: stored?.serializedDoc, clock: stored?.clock ?? 0, pending };
  });
}

/** The sync state of an owned document, read from the store if not held yet. */
export async function ensureSyncState<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
): Promise<DocSyncState<S, O> | undefined> {
  const entry = client["_docsCache"].get(docId);
  if (entry?.ownership.role !== "owner") return undefined;
  if (entry.syncState) return entry.syncState;
  const state = await readSyncState(client, docId);
  if (client["_docsCache"].get(docId) !== entry) return undefined;
  if (entry.ownership.role !== "owner") return undefined;
  // A load that finished meanwhile already holds the state.
  entry.syncState ??= state;
  return entry.syncState;
}
