import type { DocBinding, SyncResponse } from "../../../../shared/types.js";

/**
 * What the owner of a document knows about its local store: the snapshot the
 * server last certified, or the one created locally at clock 0, and the
 * batches persisted since then that the server has not acknowledged, oldest
 * first. `base` is `undefined` for a document that exists only on the server.
 *
 * The store mirrors this state. It is read once, when the document is loaded
 * or taken over, and only written afterwards, so a sync never has to check
 * whether the store changed underneath it.
 */
export type DocSyncState<S extends object, O extends object> = {
  base: S | undefined;
  clock: number;
  pending: O[][];
};

/**
 * Folds a sync response into the sync state, without touching the store or
 * the live doc. Returns `undefined` when the response changes nothing.
 *
 * `doc` holds the new base: the server's snapshot when it sent one, or the
 * previous base, with the server's operations and then the sent batches
 * applied. It becomes the live doc when the sync replaces it, and is disposed
 * by the caller otherwise.
 */
export function reconcileSyncResponse<
  D extends object,
  S extends object,
  O extends object,
>(
  docBinding: DocBinding<D, S, O>,
  args: {
    state: DocSyncState<S, O>;
    sentBatches: number;
    data: Extract<SyncResponse<S, O>, { data: unknown }>["data"];
  },
): { base: S; clock: number; doc: D; shouldReplaceDoc: boolean } | undefined {
  const { state, sentBatches, data } = args;
  const sentOperations = state.pending.slice(0, sentBatches).flat();
  const hasServerSnapshot = data.serializedDoc !== null;
  if (
    !hasServerSnapshot &&
    data.operations.length === 0 &&
    sentOperations.length === 0
  ) {
    return undefined;
  }
  const baseSerializedDoc = data.serializedDoc ?? state.base;
  if (baseSerializedDoc === undefined) return undefined;

  const doc = docBinding.deserialize(baseSerializedDoc);
  for (const operations of data.operations) {
    docBinding.applyOperations(doc, operations, { skipUndo: true });
  }
  for (const operations of sentOperations) {
    docBinding.applyOperations(doc, operations, { skipUndo: true });
  }
  return {
    base: docBinding.serialize(doc),
    clock: data.clock,
    doc,
    // The live doc already holds the sent batches. It is rebuilt when the
    // server sent a snapshot, or when its operations have to be ordered
    // before batches the live doc applied first.
    shouldReplaceDoc:
      hasServerSnapshot ||
      (data.operations.length > 0 && sentOperations.length > 0),
  };
}
