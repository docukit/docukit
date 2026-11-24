import type { SerializedDocPayload } from "../../shared/types.js";
import type { DocSyncClient } from "../index.js";

/**
 * What DocSync stored, with the operations it has not synced on top. A doc
 * that rebases in place (see `DocBinding.rebase`) keeps what undoes them, so
 * a sync can put the server's operations before them.
 */
export function loadStoredDoc<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  stored: Omit<SerializedDocPayload<S>, "docId">,
  pending: O[],
): D {
  const docBinding = client["_docBinding"];
  const doc = docBinding.deserialize(stored.serializedDoc, docId);
  if (docBinding.rebase?.(doc)) client["_rebasable"].set(doc, stored.clock);
  for (const operations of pending)
    docBinding.applyOperations(doc, operations, { skipUndo: true });
  return doc;
}
