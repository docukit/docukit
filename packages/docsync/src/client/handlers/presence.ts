import type {
  ClientSocket,
  PresenceRequest,
  PresenceResponse,
} from "../../shared/types.js";

type HandlePresenceArgs = {
  socket: ClientSocket<object, object>;
  docId: string;
  presence: unknown;
  timeoutMs?: number;
};

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

export const handlePresence = async ({
  socket,
  docId,
  presence,
  timeoutMs = 5000,
}: HandlePresenceArgs): Promise<void> => {
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
