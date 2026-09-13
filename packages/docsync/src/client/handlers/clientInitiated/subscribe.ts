import type { SubscribeDocRequest } from "../../../shared/types.js";
import type { ClientSocket } from "../../types.js";
import { request } from "../../utils/request.js";

/**
 * Subscribes to a document this client mirrors. Syncing subscribes on its
 * own; a mirror never syncs, so it asks for the document's presence and
 * collaboration updates explicitly.
 */
export const handleSubscribe = async (
  socket: ClientSocket<object, object>,
  payload: SubscribeDocRequest,
  timeoutMs = 5000,
): Promise<void> => {
  if (!socket.connected) return;
  try {
    await request(socket, "subscribe-doc", payload, timeoutMs);
  } catch {
    // The subscription is best effort: a reconnect renews it.
  }
};
