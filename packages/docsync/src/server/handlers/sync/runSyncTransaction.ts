import type { SyncRequest } from "../../../shared/types.js";
import type { ServerProvider } from "../../types.js";

export type SyncTransactionResult<S, O> = {
  docId: string;
  operations?: O[];
  serializedDoc?: S | "deleted";
  clock: number;
};

/**
 * Runs the core sync transaction: load server ops and doc, save client ops,
 * and return the result payload (operations, serializedDoc, clock).
 * When payload.operations === "deleted", marks the doc as deleted, deletes
 * all operations, and returns serializedDoc: "deleted".
 */
export async function runSyncTransaction<S extends {} = {}, O extends {} = {}>(
  provider: ServerProvider<S, O>,
  payload: SyncRequest<O>,
): Promise<SyncTransactionResult<S, O>> {
  const { docId, clock } = payload;

  if (payload.operations === "deleted") {
    return provider.transaction("readwrite", async (ctx) => {
      await ctx.deleteOperations({ docId });
      const newSerializedDoc = {
        docId,
        serializedDoc: "deleted" as const,
        clock: new Date().getTime(),
      };
      await ctx.saveSerializedDoc(newSerializedDoc);
      return newSerializedDoc;
    });
  }

  const operations = payload.operations ?? [];

  return provider.transaction("readwrite", async (ctx) => {
    const serverOps = await ctx.getOperations({ docId, clock });
    const serverDoc = await ctx.getSerializedDoc(docId);
    const newClock = await ctx.saveOperations({ docId, operations });

    const serializedDoc =
      serverDoc?.serializedDoc !== "deleted"
        ? serverDoc?.serializedDoc
        : undefined;

    return {
      docId,
      ...(serverOps.length > 0 ? { operations: serverOps.flat() } : {}),
      ...(serializedDoc ? { serializedDoc } : {}),
      clock: newClock,
    };
  });
}
