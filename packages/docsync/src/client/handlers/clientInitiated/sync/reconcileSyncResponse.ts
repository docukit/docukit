import type {
  SyncResponse,
  TransactionFlags,
} from "../../../../shared/types.js";
import type { DocSyncClient } from "../../../index.js";
import type { ClientProvider } from "../../../types.js";

export type ReconcileSyncResult<D extends object, O extends object> =
  | { type: "none" }
  | { type: "replaceDoc"; doc: D }
  | { type: "applyServerOperations"; operations: O[] };

function applyOperations<D extends object, S extends object, O extends object>(
  client: DocSyncClient<D, S, O>,
  doc: D,
  operations: O[],
  flags?: TransactionFlags,
): void {
  for (const op of operations) {
    client["_docBinding"].applyOperations(doc, op, flags);
  }
}

export async function reconcileSyncResponse<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: {
    provider: ClientProvider<S, O>;
    docId: string;
    operationsBatches: O[][];
    localOperations: O[];
    data: Extract<SyncResponse<S, O>, { data: unknown }>["data"];
  },
): Promise<ReconcileSyncResult<D, O>> {
  const { provider, docId, operationsBatches, localOperations, data } = args;
  const hasServerSnapshot = data.serializedDoc !== null;
  let didConsolidate = false;
  let replacementDoc: D | undefined;

  await provider.transaction("readwrite", async (ctx) => {
    if (operationsBatches.length > 0) {
      await ctx.deleteOperations({ docId, count: operationsBatches.length });
    }

    const stored = await ctx.getSerializedDoc({ docId });
    const baseSerializedDoc = data.serializedDoc ?? stored?.serializedDoc;
    if (baseSerializedDoc === undefined) return;

    if (
      !hasServerSnapshot &&
      stored !== undefined &&
      stored.clock >= data.clock &&
      data.operations.length === 0 &&
      localOperations.length === 0
    ) {
      return;
    }

    const doc = client["_docBinding"].deserialize(baseSerializedDoc);
    applyOperations(client, doc, data.operations, { skipUndo: true });
    applyOperations(client, doc, localOperations);
    const serializedDoc = client["_docBinding"].serialize(doc);

    const recheckStored = await ctx.getSerializedDoc({ docId });
    if (stored !== undefined && recheckStored?.clock !== stored.clock) return;
    if (stored === undefined && recheckStored !== undefined) return;

    await ctx.saveSerializedDoc({ serializedDoc, docId, clock: data.clock });
    replacementDoc = doc;
    didConsolidate = true;
  });

  if (replacementDoc && hasServerSnapshot) {
    const pendingLocalOperations =
      client["_localOpsBatchState"].get(docId)?.data ?? [];
    applyOperations(client, replacementDoc, pendingLocalOperations);
    return { type: "replaceDoc", doc: replacementDoc };
  }

  if (didConsolidate && data.operations.length > 0) {
    return { type: "applyServerOperations", operations: data.operations };
  }

  return { type: "none" };
}
