import type { PresenceRequest } from "../../../shared/types.js";
import type { DocSyncClient } from "../../index.js";
import { request } from "../../utils/request.js";

/** Set presence for a document: debounce outgoing updates, then emit to active channels. */
export function handlePresence<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; presence: unknown },
): void {
  const { docId, presence } = args;
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) {
    throw new Error(`Doc ${docId} is not loaded, cannot set presence`);
  }

  const state = client["_presenceDebounceState"].get(docId) ?? {
    data: presence,
  };
  const shouldRefreshTimeoutForRemoteChange =
    client["_changeOrigin"] !== "local" && state.timeout !== undefined;

  if (shouldRefreshTimeoutForRemoteChange) {
    clearTimeout(state.timeout);
    delete state.timeout;
  }

  state.data = presence;

  if (state.timeout === undefined) {
    const maxDebounce = client["_collabMaxDebounce"];
    if (maxDebounce === 0) {
      emitPresence(client, { docId, presence: state.data });
    } else {
      state.timeout = setTimeout(() => {
        const currentState = client["_presenceDebounceState"].get(docId);
        if (!currentState) return;

        delete currentState.timeout;
        emitPresence(client, { docId, presence: currentState.data });
      }, maxDebounce);
    }
  }

  client["_presenceDebounceState"].set(docId, state);
}

export function flushPresenceDebounce<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  args?: { timeoutBeforeChange: ReturnType<typeof setTimeout> | undefined },
): void {
  const state = client["_presenceDebounceState"].get(docId);
  if (state?.timeout === undefined) return;
  if (state.timeout === args?.timeoutBeforeChange) return;

  clearTimeout(state.timeout);
  delete state.timeout;
  emitPresence(client, { docId, presence: state.data });
}

export function emitCurrentServerPresence<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string): void {
  if (!client["_collabDocIds"].has(docId)) return;

  const state = client["_presenceDebounceState"].get(docId);
  if (!state) return;
  if (state.timeout !== undefined) return;

  emitServerPresence(client, { docId, presence: state.data });
}

function emitPresence<D extends object, S extends object, O extends object>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; presence: unknown },
): void {
  const { docId, presence } = args;
  const patch = { [client["_clientId"]]: presence };

  client["_bcHelper"]?.broadcast({ type: "PRESENCE", docId, presence: patch });
  if (!client["_collabDocIds"].has(docId)) return;
  emitServerPresence(client, { docId, presence });
}

function emitServerPresence<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; presence: unknown },
): void {
  const { docId, presence } = args;

  const socket = client["_socket"];
  if (!socket.connected) return;

  void (async () => {
    try {
      const payload: PresenceRequest = { docId, presence };
      const { error } = await request(socket, "presence", payload, 5000);
      if (error) {
        console.error(`Error setting presence for doc ${docId}:`, error);
      }
    } catch (error) {
      console.error(`Error setting presence for doc ${docId}:`, error);
    }
  })();
}
