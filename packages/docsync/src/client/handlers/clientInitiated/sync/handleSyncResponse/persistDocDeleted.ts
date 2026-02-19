import type { DocSyncClient } from "../../../../index.js";

/**
 * Persists that the document was deleted: deletes all operations for the doc
 * and saves serializedDoc "deleted" with the given clock.
 * Does not update the in-memory cache (caller should set promisedDoc to "deleted").
 */
export async function persistDocDeleted<
  D extends {},
  S extends {},
  O extends {},
>(client: DocSyncClient<D, S, O>, docId: string, clock: number): Promise<void> {
  const { provider } = await client["_localPromise"];

  await provider.transaction("readwrite", async (ctx) => {
    await ctx.deleteOperations({ docId });
    await ctx.saveSerializedDoc({ docId, serializedDoc: "deleted", clock });
  });
}
