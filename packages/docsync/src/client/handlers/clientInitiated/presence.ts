/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { PresenceRequest } from "../../../shared/types.js";
import type { DocSyncClient } from "../../index.js";
import { request } from "../../utils/request.js";
import { applyPresencePatch } from "../../utils/applyPresencePatch.js";

/**
 * Set presence for a document: debounces updates, then updates local cache,
 * broadcasts to other tabs, and sends to the server.
 */
export function handlePresence<D extends {}, S extends {}, O extends {}>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; presence: unknown },
): void {
  const { docId, presence } = args;
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) {
    throw new Error(`Doc ${docId} is not loaded, cannot set presence`);
  }

  const existingState = cacheEntry.presenceDebounceState;
  clearTimeout(existingState?.timeout);

  const timeout = setTimeout(() => {
    const entry = client["_docsCache"].get(docId);
    const state = entry?.presenceDebounceState;
    if (!entry || !state) return;

    delete entry.presenceDebounceState;

    const patch = { [client["_clientId"]]: state.data };

    applyPresencePatch(client["_clientId"], entry, patch);

    client["_bcHelper"]?.broadcast({
      type: "PRESENCE",
      docId,
      presence: patch,
    });

    const socket = client["_socket"];
    if (socket.connected) {
      void (async () => {
        try {
          const payload: PresenceRequest = { docId, presence: state.data };
          const { error } = await request(socket, "presence", payload, 5000);
          if (error) {
            console.error(`Error setting presence for doc ${docId}:`, error);
          }
        } catch (error) {
          console.error(`Error setting presence for doc ${docId}:`, error);
        }
      })();
    }
  }, client["_presenceDebounce"]);

  cacheEntry.presenceDebounceState = { timeout, data: presence };
}
