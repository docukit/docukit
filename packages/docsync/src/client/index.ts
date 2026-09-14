import { DocSyncCore } from "./core.js";
import type { Presence } from "../shared/types.js";
import type { DocData, DocObserver, GetDocArgs, QueryResult } from "./types.js";
import { handlePresence } from "./handlers/clientInitiated/presence.js";

/** UI-facing observers and presence on top of the shared sync engine. */
export class DocSyncClient<
  D extends object = object,
  S extends object = object,
  O extends object = object,
> extends DocSyncCore<D, S, O> {
  /**
   * Observe a document query with a stable snapshot and reactive updates.
   *
   * The behavior depends on which fields are provided:
   * - `{ type, id }` → Try to get an existing doc. Returns `undefined` if not found.
   * - `{ type, id, createIfMissing: true }` → Get existing doc or create it if not found.
   *
   * `getSnapshot()` returns one of these states:
   * 1. `{ status: "pending" }` - Initial state while fetching
   * 2. `{ status: "success", data: { doc, docId } }` - Document loaded successfully
   * 3. `{ status: "error", error }` - Failed to load document
   *
   * To observe document content changes, use `doc.onChange()` directly on the returned doc.
   *
   * @example
   * ```ts
   * const observer = client.getDocObserver({ type: "notes", id: "abc123" });
   * const render = () => {
   *   const result = observer.getSnapshot();
   *   if (result.status === "pending") console.log("Pending...");
   *   if (result.status === "success") console.log("Doc:", result.data?.doc);
   *   if (result.status === "error") console.error(result.error);
   * };
   * const unsubscribe = observer.subscribe(render);
   * render();
   *
   * // Clean up when done
   * unsubscribe();
   * ```
   */
  getDocObserver<T extends GetDocArgs>(
    args: T,
  ): DocObserver<
    T extends { createIfMissing: true } ? DocData<D> : DocData<D> | undefined
  > {
    type ObserverData = T extends { createIfMissing: true }
      ? DocData<D>
      : DocData<D> | undefined;

    let currentResult = (this._docsCache.get(args.id)?.queryResult ??
      this._initialQueryResult()) as QueryResult<ObserverData>;
    const listeners = new Set<() => void>();
    let unsubscribeFromDoc: (() => void) | undefined;

    const getSnapshot = () =>
      (this._docsCache.get(args.id)?.queryResult ??
        currentResult) as QueryResult<ObserverData>;
    const subscribe = (listener: () => void) => {
      listeners.add(listener);

      if (!unsubscribeFromDoc) {
        let isStartingSubscription = true;
        unsubscribeFromDoc = this.subscribeDoc(args, (nextResult) => {
          if (nextResult === currentResult) return;
          currentResult = nextResult as QueryResult<ObserverData>;
          // External-store consumers read the snapshot again immediately after
          // subscribing, so the initial synchronous update needs no callback.
          if (isStartingSubscription) return;
          let firstError: { value: unknown } | undefined;
          for (const currentListener of [...listeners]) {
            try {
              currentListener();
            } catch (error: unknown) {
              firstError ??= { value: error };
            }
          }
          if (firstError) throw firstError.value;
        });
        isStartingSubscription = false;
      }

      return () => {
        listeners.delete(listener);
        if (listeners.size > 0 || !unsubscribeFromDoc) return;
        const unsubscribe = unsubscribeFromDoc;
        unsubscribeFromDoc = undefined;
        unsubscribe();
      };
    };

    return { getSnapshot, subscribe };
  }

  /**
   * Subscribe to presence updates for a document.
   * Multiple listeners can be registered for the same document.
   * @param args - The arguments for the getPresence request.
   * @param onChange - The callback to invoke when the presence changes.
   * @returns A function to unsubscribe from presence updates.
   */
  getPresence(
    args: { docId: string | undefined },
    onChange: (presence: Presence) => void,
  ): () => void {
    const { docId } = args;
    if (!docId) return () => void undefined;
    const cacheEntry = this._docsCache.get(docId);

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
      const entry = this._docsCache.get(docId);
      if (entry) {
        entry.presenceListeners.delete(onChange);
      }
    };
  }

  setPresence({ docId, presence }: { docId: string; presence: unknown }) {
    void handlePresence(this, { docId, presence });
  }
}
