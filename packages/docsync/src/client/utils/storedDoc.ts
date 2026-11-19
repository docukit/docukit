import type { DocSyncClient } from "../index.js";
import type { ClientProviderContext, ServerOperationsBatch } from "../types.js";

/**
 * What a device stores of a document from the server: a snapshot and the
 * server batches that arrived after it.
 *
 * Each batch the server sends is appended as is, which costs as much as the
 * batch. Rewriting the snapshot instead costs as much as the whole document,
 * on every batch. The batches are folded into the snapshot when a
 * subscription has something to reconcile (local edits to send or batches
 * the client missed, once per load or reconnect) and when
 * `_serverBatchesToCompact` of them pile up during a long session.
 */
export type StoredDoc<S, O extends object> = {
  serializedDoc: S;
  /** Server clock the snapshot was folded up to. */
  snapshotClock: number;
  /** Server clock the stored copy reaches: its last batch's, or the snapshot's. */
  clock: number;
  batches: ServerOperationsBatch<O>[];
};

export async function readStoredDoc<S extends object, O extends object>(
  ctx: ClientProviderContext<S, O>,
  docId: string,
): Promise<StoredDoc<S, O> | undefined> {
  const snapshot = await ctx.getSerializedDoc({ docId });
  if (!snapshot) return undefined;
  const batches = (await ctx.getServerOperations({ docId })).filter(
    (batch) => batch.clock > snapshot.clock,
  );
  return {
    serializedDoc: snapshot.serializedDoc,
    snapshotClock: snapshot.clock,
    clock: batches.at(-1)?.clock ?? snapshot.clock,
    batches,
  };
}

/**
 * Where the stored copy is, without reading the snapshot unless no batch is
 * stored on top of it. Every stored batch follows the snapshot: saving a
 * snapshot deletes the batches it covers in the same transaction.
 */
export type StoredClock = { clock: number; batches: number };

export async function readStoredClock<S extends object, O extends object>(
  ctx: ClientProviderContext<S, O>,
  docId: string,
): Promise<StoredClock | undefined> {
  const { count, lastClock } = await ctx.countServerOperations({ docId });
  if (lastClock !== undefined) return { clock: lastClock, batches: count };
  const snapshot = await ctx.getSerializedDoc({ docId });
  return snapshot && { clock: snapshot.clock, batches: 0 };
}

/** The stored copy as a document: the snapshot with the server batches on top. */
export function deserializeStoredDoc<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, stored: StoredDoc<S, O>): D {
  const docBinding = client["_docBinding"];
  const doc = docBinding.deserialize(stored.serializedDoc);
  for (const batch of stored.batches) {
    for (const operations of batch.operations) {
      docBinding.applyOperations(doc, operations, { skipUndo: true });
    }
  }
  return doc;
}

/** The stored copy serialized, folding its batches only if it has any. */
export function serializeStoredDoc<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, stored: StoredDoc<S, O>): S {
  if (stored.batches.length === 0) return stored.serializedDoc;
  return client["_docBinding"].serialize(deserializeStoredDoc(client, stored));
}

/** Saves a snapshot at `clock` and drops the server batches it covers. */
export async function saveSnapshot<S extends object, O extends object>(
  ctx: ClientProviderContext<S, O>,
  args: { docId: string; serializedDoc: S; clock: number },
): Promise<StoredDoc<S, O>> {
  const { docId, serializedDoc, clock } = args;
  await ctx.saveSerializedDoc({ docId, serializedDoc, clock });
  await ctx.deleteServerOperations({ docId, clock });
  return { serializedDoc, snapshotClock: clock, clock, batches: [] };
}

/**
 * Appends server batches that follow `stored`, and folds them all into the
 * snapshot once there are `_serverBatchesToCompact` of them.
 */
export async function appendServerBatches<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  ctx: ClientProviderContext<S, O>,
  args: {
    docId: string;
    stored: StoredClock;
    batches: ServerOperationsBatch<O>[];
  },
): Promise<StoredClock> {
  const { docId, stored, batches } = args;
  for (const batch of batches) {
    await ctx.saveServerOperations({ docId, ...batch });
  }
  const next = {
    clock: batches.at(-1)?.clock ?? stored.clock,
    batches: stored.batches + batches.length,
  };
  if (next.batches < client["_serverBatchesToCompact"]) return next;
  const full = await readStoredDoc(ctx, docId);
  if (!full) return next;
  await saveSnapshot(ctx, {
    docId,
    serializedDoc: serializeStoredDoc(client, full),
    clock: full.clock,
  });
  return { clock: full.clock, batches: 0 };
}
