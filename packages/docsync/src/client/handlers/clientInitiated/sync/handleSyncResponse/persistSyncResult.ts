/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../../../../index.js";

export type SyncResponseData<S, O> = {
  docId: string;
  operations?: O[];
  serializedDoc?: S | "deleted";
  clock: number;
};

/**
 * Persists the sync result: deletes pushed operations, then optionally
 * consolidates server ops + client ops into the serialized doc and saves.
 * Returns whether consolidation was performed.
 */
export async function persistSyncResult<
  D extends {},
  S extends {},
  O extends {},
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  data: SyncResponseData<S, O>,
  operationsBatches: O[][],
  operations: O[],
): Promise<boolean> {
  const { provider } = await client["_localPromise"];
  const docBinding = client["_docBinding"];
  let didConsolidate = false;

  await provider.transaction("readwrite", async (ctx) => {
    if (operationsBatches.length > 0) {
      await ctx.deleteOperations({ docId, count: operationsBatches.length });
    }

    const stored = await ctx.getSerializedDoc(docId);
    if (!stored) return;
    if (stored.serializedDoc === "deleted") return;
    if (stored.clock >= data.clock) return;

    const serverOps = data.operations ?? [];
    const allOps = [...serverOps, ...operations];
    if (allOps.length === 0) return;

    const doc = docBinding.deserialize(stored.serializedDoc);
    for (const op of allOps) {
      docBinding.applyOperations(doc, op);
    }
    const serializedDoc = docBinding.serialize(doc);

    const recheckStored = await ctx.getSerializedDoc(docId);
    if (recheckStored?.clock !== stored.clock) return;

    await ctx.saveSerializedDoc({ serializedDoc, docId, clock: data.clock });
    didConsolidate = true;
  });

  return didConsolidate;
}
