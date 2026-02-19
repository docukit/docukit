/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncRequest } from "../../../shared/types.js";
import type { DocSyncServer } from "../../index.js";
import type { SyncTransactionResult } from "./runSyncTransaction.js";

const OPERATION_THRESHOLD = 100;

/**
 * If the number of operations in the result meets the threshold, squash them
 * into the serialized doc and delete one operation batch from storage.
 */
export async function squashIfNeeded<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(
  server: DocSyncServer<TContext, D, S, O>,
  payload: SyncRequest<O>,
  result: SyncTransactionResult<S, O>,
): Promise<void> {
  // TODO: maybe the squash for the delete case should be handled here
  if (result.serializedDoc === "deleted") return;
  if (!result.operations || result.operations.length < OPERATION_THRESHOLD) {
    return;
  }

  const provider = server["_provider"];
  const docBinding = server["_docBinding"];
  const {
    docId: resultDocId,
    operations: serverOps,
    serializedDoc,
    clock: resultClock,
  } = result;
  const clientOps = Array.isArray(payload.operations) ? payload.operations : [];
  const allOperations = [...serverOps, ...clientOps];

  const doc = serializedDoc
    ? docBinding.deserialize(serializedDoc)
    : docBinding.create("test", resultDocId).doc;
  allOperations.forEach((operation) => {
    docBinding.applyOperations(doc, operation);
  });
  const newSerializedDoc = docBinding.serialize(doc);

  await provider.transaction("readwrite", async (ctx) => {
    await ctx.saveSerializedDoc({
      docId: resultDocId,
      serializedDoc: newSerializedDoc,
      clock: resultClock,
    });
    await ctx.deleteOperations({ docId: resultDocId, count: 1 });
  });
}
