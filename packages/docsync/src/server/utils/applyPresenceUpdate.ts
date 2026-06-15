import type { Presence } from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";

/**
 * Updates server presence state for a document and broadcasts the change
 * to other clients in the doc room. Handlers import and call this directly.
 */
export function applyPresenceUpdate<
  TContext,
  S extends object,
  O extends object,
>(
  presenceByDoc: Map<string, Presence>,
  socket: ServerConnectionSocket<TContext, S, O>,
  clientId: string,
  args: { docId: string; presence: unknown },
): void {
  const { docId, presence } = args;
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
