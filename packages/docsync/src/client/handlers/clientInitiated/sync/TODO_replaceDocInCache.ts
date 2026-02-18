/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../../../index.js";

/**
 * Replaces the cached document (e.g. when server responds with a squashed doc).
 * Keeps refCount, presence, and presenceListeners unchanged.
 */
export async function replaceDocInCache<
  D extends {},
  S extends {},
  O extends {},
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; doc?: D; serializedDoc?: S },
): Promise<void> {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;
  if (args.doc === undefined && args.serializedDoc === undefined) return;

  const newDoc =
    args.doc ?? client["_docBinding"].deserialize(args.serializedDoc!);

  client["_docsCache"].set(args.docId, {
    promisedDoc: Promise.resolve(newDoc),
    refCount: cacheEntry.refCount,
    presence: cacheEntry.presence,
    presenceListeners: cacheEntry.presenceListeners,
    pushStatus: cacheEntry.pushStatus,
    localOpsBatchState: cacheEntry.localOpsBatchState,
    presenceDebounceState: cacheEntry.presenceDebounceState,
  });
}
