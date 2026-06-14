import type { SyncRequest, SyncResponse } from "../../shared/types.js";
import type { ClientSocket } from "../types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

export function requestSync<S extends object, O extends object>(
  socket: ClientSocket<S, O>,
  payload: SyncRequest<S, O>,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<SyncResponse<S, O>> {
  return new Promise((resolve, reject) => {
    // TODO: socket.io has props to define it globally
    const timeout = setTimeout(
      () => reject(new Error("Request timeout: sync")),
      timeoutMs,
    );

    socket.emit("sync", payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}
