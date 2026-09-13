import type { DocSyncClient } from "../index.js";
import { setupDocChangeListener } from "./setupDocChangeListener.js";

type HistorySource<D extends object> = {
  doc: D;
  promisedDoc: Promise<D | undefined>;
};

/**
 * Swaps the live doc of a loaded document for `doc`, importing the undo
 * history exported from the doc being replaced. The cache entry itself is
 * kept: it identifies the loaded document for the sync attempt or ownership
 * change that is replacing its doc, and for every subscriber holding it.
 */
export function replaceDocInCache<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: {
    docId: string;
    doc: D;
    exportedHistory?: { promisedDoc: Promise<D | undefined>; value: unknown };
  },
) {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;

  const previousPromisedDoc = cacheEntry.promisedDoc;
  const nextPromisedDoc = Promise.resolve(args.doc);
  const docBinding = client["_docBinding"];
  let historyImportError: { historyImportError: unknown } | undefined;
  if (
    args.exportedHistory?.promisedDoc === previousPromisedDoc &&
    docBinding.importHistory
  ) {
    try {
      docBinding.importHistory(args.doc, args.exportedHistory.value);
    } catch (error) {
      historyImportError = { historyImportError: error };
    }
  }
  setupDocChangeListener(client, args);
  cacheEntry.promisedDoc = nextPromisedDoc;

  void previousPromisedDoc
    .then((previousDoc) => {
      const currentEntry = client["_docsCache"].get(args.docId);
      if (
        currentEntry?.promisedDoc === nextPromisedDoc &&
        previousDoc &&
        previousDoc !== args.doc
      ) {
        client["_docBinding"].dispose(previousDoc);
      }
    })
    .catch(() => undefined);

  return historyImportError;
}

/** Resolves the live doc whose undo history a replacement should inherit. */
export async function resolveHistorySource<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
): Promise<HistorySource<D> | undefined> {
  const docBinding = client["_docBinding"];
  if (!docBinding.exportHistory) return;
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;
  const doc = await cacheEntry.promisedDoc;
  if (!doc) return;
  return { doc, promisedDoc: cacheEntry.promisedDoc };
}

export function exportHistoryFromCurrentSource<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  source: HistorySource<D> | undefined,
): { promisedDoc: Promise<D | undefined>; value: unknown } | undefined {
  if (!source) return;
  const cacheEntry = client["_docsCache"].get(docId);
  const docBinding = client["_docBinding"];
  if (
    cacheEntry?.promisedDoc !== source.promisedDoc ||
    !docBinding.exportHistory
  )
    return;
  return {
    promisedDoc: source.promisedDoc,
    value: docBinding.exportHistory(source.doc),
  };
}

/**
 * Resolves the in-memory operations batch across the history export.
 *
 * `exportHistory` force-commits the live doc, which pushes the resulting
 * operation into the batch *and* can flush it in the same synchronous turn:
 * `_flushLocalOperations` deletes the batch entry before its first await, so
 * reading the batch only after the export would miss that operation. The
 * replacement doc would then be swapped in without an edit whose undo entry we
 * just exported. The flush keeps the array it took, and the push happens before
 * it, so the reference captured beforehand still holds the operation.
 */
export function resolvePendingMemoryOperations<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  batchBeforeExport: O[] | undefined,
): O[] {
  const batchAfterExport = client["_localOpsBatchState"].get(docId)?.data;
  if (batchBeforeExport === undefined) return batchAfterExport ?? [];
  if (
    batchAfterExport === undefined ||
    batchAfterExport === batchBeforeExport
  ) {
    return batchBeforeExport;
  }
  return [...batchBeforeExport, ...batchAfterExport];
}
