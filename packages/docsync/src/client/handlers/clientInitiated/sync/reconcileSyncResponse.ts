import type {
  SyncResponse,
  TransactionFlags,
} from "../../../../shared/types.js";
import type { DocSyncClient } from "../../../index.js";
import type { ClientProvider } from "../../../types.js";
import { getLocalDocVersion } from "../../../utils/localDocVersion.js";

export type ReconcileSyncResult<D extends object, O extends object> =
  | { type: "none" }
  | { type: "replaceDoc"; doc: D }
  | { type: "applyServerOperations"; operations: O[] };

type PreparedSyncReconciliation<D extends object, O extends object> = {
  didConsolidate: boolean;
  shouldReplaceDoc: boolean;
  pendingProviderOperations: O[];
  replacementDoc?: D;
  serverOperations: O[];
};

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

/**
 * Performs the asynchronous provider transaction and prepares a possible
 * replacement. The live in-memory document is intentionally left untouched.
 *
 * Only the tab that owns a document runs this, so the store cannot change
 * under the transaction except through this tab's own flushes, which are the
 * `pendingProviderOperations` picked up below.
 */
export async function prepareSyncReconciliation<
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
    isCurrent: () => boolean;
  },
): Promise<PreparedSyncReconciliation<D, O>> {
  const {
    provider,
    docId,
    operationsBatches,
    localOperations,
    data,
    isCurrent,
  } = args;
  const hasServerSnapshot = data.serializedDoc !== null;
  let didConsolidate = false;
  let pendingProviderOperations: O[] = [];
  let replacementDoc: D | undefined;

  await provider.transaction("readwrite", async (ctx) => {
    if (!isCurrent()) return;
    const stored = await ctx.getSerializedDoc({ docId });
    if (!isCurrent()) return;
    const baseSerializedDoc = data.serializedDoc ?? stored?.serializedDoc;
    if (baseSerializedDoc === undefined) return;
    if (
      !hasServerSnapshot &&
      data.operations.length === 0 &&
      localOperations.length === 0
    ) {
      return;
    }

    const currentOperationsBatches = await ctx.getOperations({ docId });
    if (!isCurrent()) return;
    pendingProviderOperations = currentOperationsBatches
      .slice(operationsBatches.length)
      .flat();

    const doc = client["_docBinding"].deserialize(baseSerializedDoc);
    applyOperations(client, doc, data.operations, { skipUndo: true });
    applyOperations(client, doc, localOperations, { skipUndo: true });
    const serializedDoc = client["_docBinding"].serialize(doc);

    // This tab is the only writer of the document's store, so the snapshot
    // read above is still what is stored: nothing has to be checked again.
    // Once the snapshot write starts, finish the matching operation cleanup in
    // this transaction even if the connection changes. Returning between the
    // two writes could commit a snapshot that already contains the operations
    // while leaving those same operations queued to be applied a second time.
    await ctx.saveSerializedDoc({ serializedDoc, docId, clock: data.clock });
    if (operationsBatches.length > 0) {
      await ctx.deleteOperations({ docId, count: operationsBatches.length });
    }
    replacementDoc = doc;
    didConsolidate = true;
  });

  return {
    didConsolidate,
    shouldReplaceDoc:
      hasServerSnapshot ||
      (data.operations.length > 0 && localOperations.length > 0),
    pendingProviderOperations,
    ...(replacementDoc && { replacementDoc }),
    serverOperations: data.operations,
  };
}

/**
 * Finishes reconciliation synchronously so local edits cannot land between
 * rebuilding a replacement document and swapping it into the cache.
 *
 * `pendingMemoryOperations` is resolved by the caller rather than read from the
 * client here: exporting the undo history force-commits the live doc, which can
 * flush and delete the in-memory batch in the same synchronous turn.
 */
export function finalizeSyncReconciliation<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: {
    docId: string;
    prepared: PreparedSyncReconciliation<D, O>;
    requestLocalVersion: number;
    pendingMemoryOperations: O[];
  },
): ReconcileSyncResult<D, O> {
  const { docId, prepared, requestLocalVersion, pendingMemoryOperations } =
    args;

  if (prepared.replacementDoc && prepared.shouldReplaceDoc) {
    const hasUnrebuildableLocalMemory =
      getLocalDocVersion(client, docId) > requestLocalVersion &&
      prepared.pendingProviderOperations.length === 0 &&
      pendingMemoryOperations.length === 0;

    if (hasUnrebuildableLocalMemory) {
      if (prepared.didConsolidate && prepared.serverOperations.length > 0) {
        return {
          type: "applyServerOperations",
          operations: prepared.serverOperations,
        };
      }
      return { type: "none" };
    }

    applyOperations(
      client,
      prepared.replacementDoc,
      prepared.pendingProviderOperations,
      { skipUndo: true },
    );
    applyOperations(client, prepared.replacementDoc, pendingMemoryOperations, {
      skipUndo: true,
    });
    return { type: "replaceDoc", doc: prepared.replacementDoc };
  }

  if (prepared.didConsolidate && prepared.serverOperations.length > 0) {
    return {
      type: "applyServerOperations",
      operations: prepared.serverOperations,
    };
  }

  return { type: "none" };
}
