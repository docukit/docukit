import type {
  UnsubscribeDocRequest,
  UnsubscribeDocResponse,
} from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import { applyPresenceUpdate } from "../utils/applyPresenceUpdate.js";
import { broadcastCollaborationState } from "../utils/broadcastCollaborationState.js";

export type UnsubscribeDocHandler = (
  payload: UnsubscribeDocRequest,
  cb: (res: UnsubscribeDocResponse) => void,
) => void | Promise<void>;

export function handleUnsubscribeDoc<
  TContext = unknown,
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({
  server,
  socket,
  userId,
  deviceId,
  clientId,
}: {
  server: DocSyncServer<TContext, D, S, O>;
  socket: ServerConnectionSocket<TContext, S, O>;
  userId: string;
  deviceId: string;
  clientId: string;
}): void {
  const socketToDocsMap = server["_socketToDocsMap"];
  const presenceByDoc = server["_presenceByDoc"];

  socket.on(
    "unsubscribe-doc",
    (
      { docId }: UnsubscribeDocRequest,
      cb: (res: UnsubscribeDocResponse) => void,
    ): Promise<void> =>
      // In the document's order, so a push never reaches a subscription that
      // a later sync of this same connection opens again.
      server["_inDocOrder"](docId, async () => {
        await socket.leave(`doc:${docId}`);

        const subscribedDocs = socketToDocsMap.get(socket.id);
        if (subscribedDocs) {
          subscribedDocs.delete(docId);
          if (subscribedDocs.size === 0) {
            socketToDocsMap.delete(socket.id);
          }
        }

        applyPresenceUpdate(presenceByDoc, socket, clientId, {
          docId,
          presence: null,
        });
        broadcastCollaborationState(server, docId);

        server["_emit"](server["_docUnsubscribeEventListeners"], {
          userId,
          deviceId,
          clientId,
          docId,
          reason: "unsubscribe-doc",
        });

        cb({ success: true });
      }),
  );
}
