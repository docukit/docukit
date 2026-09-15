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
  signal?: AbortSignal,
): Promise<ResponseOf<S, O, E>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request aborted", { cause: signal.reason }));
      return;
    }
    const abort = () => {
      clearTimeout(timeout);
      reject(new Error("Request aborted", { cause: signal?.reason }));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      reject(new Error(`Request timeout: ${String(event)}`));
    }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    (socket.emit as (ev: E, p: unknown, cb: (res: unknown) => void) => void)(
      event,
      payload,
      (response) => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        resolve(response as ResponseOf<S, O, E>);
      },
    );
  });
}
