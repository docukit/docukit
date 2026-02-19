import type { Presence } from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";

/**
 * Updates server presence state for a document and broadcasts the change
 * to other clients in the doc room. Handlers import and call this directly.
 */
export function applyPresenceUpdate<
  S extends {} = {},
  O extends {} = {},
  TContext = {},
>(
  presenceByDoc: Map<string, Presence>,
  socket: ServerConnectionSocket<S, O, TContext>,
  args: { docId: string; presence: unknown },
): void {
  const { docId, presence } = args;
  const { clientId } = socket.data;
  const currentPresence = presenceByDoc.get(docId) ?? {};

  if (presence === null || presence === undefined) {
    delete currentPresence[clientId];
    if (Object.keys(currentPresence).length > 0) {
      presenceByDoc.set(docId, currentPresence);
    } else {
      presenceByDoc.delete(docId);
    }
  } else {
    const newPresence = { ...currentPresence, [clientId]: presence };
    presenceByDoc.set(docId, newPresence);
  }

  socket
    .to(`doc:${docId}`)
    .emit("presence", { docId, presence: { [clientId]: presence ?? null } });
}
