/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { PresenceRequest, PresenceResponse } from "../../shared/types.js";
import type { ClientSocket } from "../types.js";
import type { DocSyncClient } from "../index.js";

const requestPresence = (
  socket: ClientSocket<object, object>,
  payload: PresenceRequest,
  timeoutMs: number,
): Promise<PresenceResponse> => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Request timeout: presence"));
    }, timeoutMs);
    socket.emit("presence", payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
};

/** Registers the socket listener for incoming presence updates from the server. */
export function handlePresence<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({ client }: { client: DocSyncClient<D, S, O> }): void {
  client["_socket"].on("presence", (payload) => {
    const cacheEntry = client["_docsCache"].get(payload.docId);
    if (!cacheEntry) return;
    client["_applyPresencePatch"](cacheEntry, payload.presence);
  });
}

/** Sends presence to the server (request/response). */
export const sendPresence = async ({
  socket,
  docId,
  presence,
  timeoutMs = 5000,
}: {
  socket: ClientSocket<object, object>;
  docId: string;
  presence: unknown;
  timeoutMs?: number;
}): Promise<void> => {
  if (!socket.connected) return;
  try {
    const payload: PresenceRequest = { docId, presence };
    const { error } = await requestPresence(socket, payload, timeoutMs);
    if (error) {
      console.error(`Error setting presence for doc ${docId}:`, error);
    }
  } catch (error) {
    console.error(`Error setting presence for doc ${docId}:`, error);
  }
};
