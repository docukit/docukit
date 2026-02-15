import type {
  UnsubscribeDocRequest,
  UnsubscribeDocResponse,
} from "../../server/handlers/unsubscribe.js";
import type { ClientSocket } from "../../shared/types.js";

const requestUnsubscribe = (
  socket: ClientSocket<object, object>,
  payload: UnsubscribeDocRequest,
  timeoutMs: number,
): Promise<UnsubscribeDocResponse> => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Request timeout: unsubscribe-doc"));
    }, timeoutMs);
    socket.emit("unsubscribe-doc", payload, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
};

export const handleUnsubscribe = async (
  socket: ClientSocket<object, object>,
  payload: UnsubscribeDocRequest,
  timeoutMs = 5000,
): Promise<void> => {
  if (!socket.connected) return;
  try {
    await requestUnsubscribe(socket, payload, timeoutMs);
  } catch {
    // Ignore cleanup failures (disconnects, timeouts, transient server issues).
  }
};
