import type { PresenceRequest } from "../../../shared/types.js";
import type { ClientSocket } from "../../types.js";
import { request } from "../../utils/request.js";

/** Sends presence to the server (request/response). */
export const handlePresence = async ({
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
    const { error } = await request(socket, "presence", payload, timeoutMs);
    if (error) {
      console.error(`Error setting presence for doc ${docId}:`, error);
    }
  } catch (error) {
    console.error(`Error setting presence for doc ${docId}:`, error);
  }
};
