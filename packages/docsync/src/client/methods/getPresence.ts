import type { Presence } from "../../shared/types.js";
import type { DocSyncClient } from "../index.js";

export function getPresenceMethod<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string | undefined },
  onChange: (presence: Presence) => void,
): () => void {
  const { docId } = args;
  if (!docId) return () => void undefined;
  const cacheEntry = client["_docsCache"].get(docId);

  if (!cacheEntry) {
    throw new Error(
      `Cannot subscribe to presence for document "${docId}" - document not loaded.`,
    );
  }

  // Add listener to the set
  cacheEntry.presenceListeners.add(onChange);

  // Immediately call with current presence if available
  if (Object.keys(cacheEntry.presence).length > 0) {
    onChange(cacheEntry.presence);
  }

  // Return unsubscribe function that removes only this listener
  return () => {
    const entry = client["_docsCache"].get(docId);
    if (entry) {
      entry.presenceListeners.delete(onChange);
    }
  };
}
