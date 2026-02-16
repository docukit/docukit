import type { UnsubscribeDocRequest } from "../../../shared/types.js";
import type { ClientSocket } from "../../types.js";
import { request } from "../../utils/request.js";

export const handleUnsubscribe = async (
  socket: ClientSocket<object, object>,
  payload: UnsubscribeDocRequest,
  timeoutMs = 5000,
): Promise<void> => {
  if (!socket.connected) return;
  try {
    await request(socket, "unsubscribe-doc", payload, timeoutMs);
  } catch {
    // Ignore cleanup failures (disconnects, timeouts, transient server issues).
  }
};
