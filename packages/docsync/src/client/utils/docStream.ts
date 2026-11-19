import type { DocSyncClient } from "../index.js";
import type {
  ClientProvider,
  OperationsBatch,
  ServerOperationsBatch,
} from "../types.js";
import { handleSync } from "../handlers/clientInitiated/sync/sync.js";
import { dispatchLocalDocFound } from "./dispatchDocQueryAction.js";
import {
  exportHistoryFromCurrentSource,
  replaceDocInCache,
  resolvePendingMemoryOperations,
} from "./liveDoc.js";
import {
  type StoredDoc,
  type StoredClock,
  appendServerBatches,
  deserializeStoredDoc,
  readStoredClock,
  readStoredDoc,
} from "./storedDoc.js";

/**
 * How a document's server batches reach this client once it subscribed on the
 * current connection.
 *
 * The server saves the batches of a document one at a time and sends each
 * one, in that order, to every subscriber on its connection: the operations to
 * other devices, a bare notice to other tabs of the sender's device, and the
 * clock in the response to the sender. Batches are numbered one by one (see
 * `ServerProviderContext.saveOperations`), so the stream only says where it
 * starts: each later batch is the one after the previous.
 *
 * Every batch that changes the stored copy waits in `folds` until the copy is
 * exactly one batch behind it. Tabs of a device share that copy, and each one
 * stores what it can in clock order: a batch a sibling tab stored first is
 * skipped by clock, never applied twice.
 */
export type DocStream<O> = {
  generation: number;
  /** Clock of the last batch this connection received or saved. */
  clock: number;
  folds: Fold<O>[];
  /** The last integration queued, see `inStreamOrder`. */
  tail: Promise<void>;
  /** Set while a batch waits for a gap in storage, see `watchStorageGap`. */
  gapTimer?: ReturnType<typeof setTimeout>;
};

/**
 * A server batch to store, with the ids of the local batches it acknowledges
 * when this client sent it.
 */
type Fold<O> = { clock: number; operations: O[]; ids: number[] };

export function startDocStream<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  stream: { generation: number; clock: number },
) {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;
  const previous = cacheEntry.stream;
  cacheEntry.stream = {
    ...stream,
    // Batches already received keep their clocks; storing them later is
    // still right, and each is skipped once the copy has it.
    folds: previous?.folds ?? [],
    tail: previous?.tail ?? Promise.resolve(),
  };
  return cacheEntry.stream;
}

/**
 * Forgets the stream and syncs again from the stored clock, which subscribes
 * anew. Batches pushed before the new response are in it; the ones after it
 * are numbered from its clock.
 */
export function restartDocStream<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string) {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry?.stream) return;
  const { folds, tail } = cacheEntry.stream;
  cacheEntry.stream = { generation: -1, clock: 0, folds, tail };
  void handleSync(client, docId);
}

export function isStreaming<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  stream: DocStream<O> | undefined,
): stream is DocStream<O> {
  return stream?.generation === client["_connectionGeneration"];
}

/**
 * Runs `task` once every integration queued earlier for the document has
 * finished, so batches reach storage and the live doc in the server's order.
 */
export function inStreamOrder<T, O>(
  stream: DocStream<O>,
  task: () => Promise<T>,
) {
  const result = stream.tail.then(task);
  stream.tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function getLiveClock<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, doc: D) {
  return client["_liveClocks"].get(doc);
}

/** Records which server clock `doc` shows under its local edits. */
export function setLiveClock<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, doc: D, clock: number) {
  client["_liveClocks"].set(doc, clock);
}

/**
 * Stores the queued batches up to `clock` that follow the stored copy, in
 * order, and deletes the local batches they acknowledge. Returns the stored
 * copy and the local batches still pending. Later batches wait: the live doc
 * is brought to `clock` from what this returns, so a local batch acknowledged
 * after it must still count as pending.
 */
async function storeFolds<D extends object, S extends object, O extends object>(
  client: DocSyncClient<D, S, O>,
  args: {
    docId: string;
    stream: DocStream<O>;
    provider: ClientProvider<S, O>;
    clock: number;
    /** Whether the live doc may be rebuilt, given the pending local batches. */
    readDoc: (pending: OperationsBatch<O>[]) => boolean;
  },
) {
  const { docId, stream, provider } = args;
  let storedBefore = Infinity;
  const [state, done] = await provider.transaction("readwrite", async (ctx) => {
    const stored = await readStoredClock(ctx, docId);
    const batches = await ctx.getOperations({ docId });
    if (!stored) return [{ stored, pending: batches }, 0] as const;
    storedBefore = stored.clock;

    const append: ServerOperationsBatch<O>[] = [];
    let clock = stored.clock;
    let done = 0;
    const acknowledged = new Set<number>();
    for (const fold of stream.folds) {
      // A batch the copy already has (stored by a sibling tab, or within a
      // snapshot) only acknowledges; a later one waits for the gap to fill.
      if (fold.clock > clock + 1 || fold.clock > args.clock) break;
      if (fold.clock === clock + 1 && fold.operations.length > 0) {
        append.push({ clock: fold.clock, operations: fold.operations });
        clock = fold.clock;
      }
      for (const id of fold.ids) acknowledged.add(id);
      done += 1;
    }
    const next =
      append.length > 0
        ? await appendServerBatches(client, ctx, {
            docId,
            stored,
            batches: append,
          })
        : stored;
    if (acknowledged.size > 0) {
      await ctx.deleteOperations({ docId, ids: [...acknowledged] });
    }
    const pending = batches.filter((batch) => !acknowledged.has(batch.id));
    // Read in this same transaction: the live doc must not lag behind what
    // storage holds for longer than it takes to rebuild it.
    const doc = args.readDoc(pending)
      ? await readStoredDoc(ctx, docId)
      : undefined;
    return [{ stored: doc ? { ...next, doc } : next, pending }, done] as const;
  });
  stream.folds.splice(0, done);
  if (state.stored && state.stored.clock > storedBefore) {
    announceStoredBatches(client, { docId, clock: state.stored.clock });
  }
  return state;
}

/**
 * Tells the other tabs of this device that the storage they share holds the
 * server batches up to `clock`. Subscribed tabs receive every batch pushed to
 * them anyway; this is for the ones that are not (see `receiveStoredBatches`).
 */
export function announceStoredBatches<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, args: { docId: string; clock: number }) {
  client["_bcHelper"]?.broadcast({ type: "STORED", ...args });
}

/**
 * Another tab of this device stored server batches up to `clock`.
 *
 * - A subscribed tab receives every batch itself, but a batch it received may
 *   be waiting for this storage: the one before it came from that sibling
 *   tab. It stores what it can now and brings its live doc up to it, in the
 *   stream's order.
 * - A tab that is not subscribed, because it is offline, receives no pushes:
 *   it brings its live doc up to storage, with its pending local operations
 *   on top, in the stream's order.
 */
export function receiveStoredBatches<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, args: { docId: string; clock: number }) {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;
  const subscribed = cacheEntry.stream;
  if (isStreaming(client, subscribed)) {
    if (subscribed.folds.length === 0) return;
    const { clock } = subscribed;
    void inStreamOrder(subscribed, () =>
      catchUpLiveDoc(client, { docId: args.docId, stream: subscribed, clock }),
    );
    return;
  }
  const stream = (cacheEntry.stream ??= {
    generation: -1,
    clock: 0,
    folds: [],
    tail: Promise.resolve(),
  });
  void inStreamOrder(stream, () => catchUpLiveDoc(client, { ...args, stream }));
}

/**
 * Swaps the live doc for the stored copy with the pending local batches on
 * top. Synchronous: an edit cannot land between reading what is pending and
 * swapping the doc.
 */
function rebuildLiveDoc<D extends object, S extends object, O extends object>(
  client: DocSyncClient<D, S, O>,
  args: {
    docId: string;
    liveDoc: D;
    promisedDoc: Promise<D | undefined>;
    stored: StoredDoc<S, O>;
    pending: OperationsBatch<O>[];
  },
) {
  const { docId, liveDoc, promisedDoc, stored, pending } = args;
  const docBinding = client["_docBinding"];
  const batchBeforeExport = client["_localOpsBatchState"].get(docId)?.data;
  const exportedHistory = exportHistoryFromCurrentSource(client, docId, {
    doc: liveDoc,
    promisedDoc,
  });
  const memory = resolvePendingMemoryOperations(
    client,
    docId,
    batchBeforeExport,
  );
  const doc = deserializeStoredDoc(client, stored);
  const local = [...pending.flatMap((batch) => batch.operations), ...memory];
  for (const operations of local) {
    docBinding.applyOperations(doc, operations, { skipUndo: true });
  }
  setLiveClock(client, doc, stored.clock);
  const replaceResult = replaceDocInCache(client, {
    docId,
    doc,
    ...(exportedHistory && { exportedHistory }),
  });
  dispatchLocalDocFound(client, docId, { doc, docId });
  if (replaceResult) throw replaceResult.historyImportError;
}

/**
 * Brings storage and the live doc up to the batch with `clock`, the latest the
 * stream delivered.
 *
 * - `pushed`: `operations` came from another device; the live doc lacks them.
 * - `held`: the live doc holds the batch already: this client's own, or one
 *   from another tab of this device, which reached it through the shared
 *   storage and the BroadcastChannel.
 * - `catchUp`: a subscription response was reconciled; the live doc has to
 *   show `clock`, rebuilt from storage if it does not.
 */
async function integrateBatch<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: {
    docId: string;
    stream: DocStream<O>;
    clock: number;
    batch:
      | { mode: "pushed"; operations: O[] }
      | { mode: "held" }
      | { mode: "catchUp" };
  },
) {
  const { docId, stream, clock, batch } = args;
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;
  const isLoaded = () =>
    client["_docsCache"].get(docId) === cacheEntry &&
    cacheEntry.stream?.folds === stream.folds;
  const { provider } = await client["_localPromise"];
  // Rebuilding the live doc needs the stored doc, which is read only when a
  // rebuild may follow. `always` covers a guess that missed.
  let always = false;

  for (;;) {
    if (!isLoaded()) return;
    // Local edits still in memory go to storage first, so the pending
    // batches read below are all of them.
    if (
      client["_localOpsBatchState"].has(docId) ||
      client["_localWrites"].has(docId)
    ) {
      await client["_flushLocalOperations"](docId, { sync: false });
      continue;
    }
    const finishedWrites = client["_finishedLocalWrites"];
    const promisedDoc = cacheEntry.promisedDoc;
    const liveDocBefore = await promisedDoc;
    const liveClockBefore =
      liveDocBefore && getLiveClock(client, liveDocBefore);
    const { stored, pending } = await storeFolds(client, {
      docId,
      stream,
      provider,
      clock,
      readDoc: (pending) => {
        if (always) return true;
        if (batch.mode === "catchUp") return liveClockBefore !== clock;
        if (liveClockBefore !== undefined && liveClockBefore >= clock) {
          return false;
        }
        if (liveClockBefore !== clock - 1) return true;
        return (
          batch.mode === "pushed" &&
          (pending.length > 0 ||
            (client["_localOpsBatchState"].get(docId)?.data.length ?? 0) > 0)
        );
      },
    });
    const liveDoc = await promisedDoc;
    if (!isLoaded()) return;
    // A write that started and finished meanwhile may or may not be in
    // `pending`: read again. Edits since are still in memory.
    if (
      client["_localWrites"].has(docId) ||
      client["_finishedLocalWrites"] !== finishedWrites ||
      cacheEntry.promisedDoc !== promisedDoc
    ) {
      continue;
    }
    if (!stored || !liveDoc) {
      // Nothing local to build on. A subscription response brings what the
      // server has, unless this is the response itself.
      if (batch.mode !== "catchUp") restartDocStream(client, docId);
      return;
    }
    watchStorageGap(client, { docId, stream, storedClock: stored.clock });
    const hasLocalOperations =
      pending.length > 0 ||
      (client["_localOpsBatchState"].get(docId)?.data.length ?? 0) > 0;

    const liveClock = getLiveClock(client, liveDoc);
    if (batch.mode === "catchUp") {
      if (liveClock !== clock && stored.clock >= clock) {
        if (!stored.doc) {
          always = true;
          continue;
        }
        rebuildLiveDoc(client, {
          docId,
          liveDoc,
          promisedDoc,
          stored: stored.doc,
          pending,
        });
      }
      return;
    }
    if (liveClock !== undefined && liveClock >= clock) return;
    if (liveClock === clock - 1) {
      // The live doc holds the operations already, in the server's place:
      // every operation it has on top was made after them.
      if (batch.mode === "held") {
        setLiveClock(client, liveDoc, clock);
        return;
      }
      // No local operation sits where the server put this batch.
      if (!hasLocalOperations) {
        for (const operation of batch.operations) {
          client["_applyOperationsFrom"]("network", liveDoc, operation, {
            skipUndo: true,
          });
        }
        setLiveClock(client, liveDoc, clock);
        return;
      }
    }
    if (stored.clock >= clock) {
      // The live doc holds local operations the server puts after this
      // batch, or it lags behind storage.
      if (!stored.doc) {
        always = true;
        continue;
      }
      rebuildLiveDoc(client, {
        docId,
        liveDoc,
        promisedDoc,
        stored: stored.doc,
        pending,
      });
      return;
    }
    // Storage waits for a batch another tab of this device sent and has yet
    // to store. The live doc may hold local operations the server puts after
    // this batch, which cannot be told apart from that tab's, so it waits:
    // once the tab stores its batch, `receiveStoredBatches` rebuilds it. If
    // the tab died, `watchStorageGap` subscribes again.
    return;
  }
}

/**
 * A batch waits to be stored when storage still lacks the one before it. That
 * one belongs to another tab of this device, which got its clock from the
 * server and stores it right after. If that tab died in between, nothing
 * else would: once the gap outlives `_storageGapTimeout`, this tab subscribes
 * again from its stored clock and gets the missing batches from the server.
 *
 * The dead tab's batch is still among the pending local batches, so the new
 * subscription sends it again and the server saves it twice. Telling it apart
 * needs batch ids.
 */
function watchStorageGap<D extends object, S extends object, O extends object>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; stream: DocStream<O>; storedClock: number },
) {
  const { docId, stream, storedClock } = args;
  const waiting = stream.folds[0];
  if (!waiting || waiting.clock <= storedClock + 1 || stream.gapTimer) return;
  stream.gapTimer = setTimeout(() => {
    delete stream.gapTimer;
    const cacheEntry = client["_docsCache"].get(docId);
    // Stored meanwhile, or this stream already ended.
    if (cacheEntry?.stream !== stream || stream.folds[0] !== waiting) return;
    if (!isStreaming(client, stream)) return;
    restartDocStream(client, docId);
  }, client["_storageGapTimeout"]);
}

/** A batch pushed by the server: `operations` is absent for a sibling tab's. */
export function receivePushedBatch<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; operations: O[] | undefined },
) {
  const { docId, operations } = args;
  const stream = client["_docsCache"].get(docId)?.stream;
  // Pushed before this client subscribed again: the response brings it.
  if (!isStreaming(client, stream)) return;
  stream.clock += 1;
  const clock = stream.clock;
  if (operations) stream.folds.push({ clock, operations, ids: [] });
  void inStreamOrder(stream, () =>
    integrateBatch(client, {
      docId,
      stream,
      clock,
      batch: operations ? { mode: "pushed", operations } : { mode: "held" },
    }),
  ).catch((error: unknown) => {
    // Subscribe again from whatever storage holds, and keep the failure loud.
    restartDocStream(client, docId);
    throw error;
  });
}

/**
 * The server saved this client's batch with `clock`. Its operations are
 * already in the live doc, so it only has to reach storage, acknowledging the
 * local batches it was made from.
 */
export function receiveOwnBatch<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: {
    docId: string;
    stream: DocStream<O>;
    clock: number;
    operations: O[];
    ids: number[];
  },
) {
  const { docId, stream, clock, operations, ids } = args;
  stream.clock = clock;
  stream.folds.push({ clock, operations, ids });
  return inStreamOrder(stream, () =>
    integrateBatch(client, { docId, stream, clock, batch: { mode: "held" } }),
  );
}

/**
 * After a subscription response, makes sure the live doc shows `clock`: it
 * can lag behind storage when another tab of this device stored batches while
 * this one was offline. Runs inside the response's own stream task.
 */
export function catchUpLiveDoc<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; stream: DocStream<O>; clock: number },
) {
  return integrateBatch(client, { ...args, batch: { mode: "catchUp" } });
}
