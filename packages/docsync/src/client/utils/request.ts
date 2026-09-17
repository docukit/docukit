import type { ClientToServerEvents } from "../../shared/types.js";
import type { ClientSocket } from "../types.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

type ResponseOf<S, O, E extends keyof ClientToServerEvents<S, O>> = Parameters<
  Parameters<ClientToServerEvents<S, O>[E]>[1]
>[0];

/**
 * Send a request to the server for a DocSync event and return the response.
 * Applies a timeout to avoid hanging if the socket disconnects during the request.
 */
export function request<S, O, E extends keyof ClientToServerEvents<S, O>>(
  socket: ClientSocket<S, O>,
  event: E,
  payload: Parameters<ClientToServerEvents<S, O>[E]>[0],
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<ResponseOf<S, O, E>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Request timeout: ${String(event)}`)),
      timeoutMs,
    );
    (socket.emit as (ev: E, p: unknown, cb: (res: unknown) => void) => void)(
      event,
      payload,
      (response) => {
        clearTimeout(timeout);
        resolve(response as ResponseOf<S, O, E>);
      },
    );
  });
}
