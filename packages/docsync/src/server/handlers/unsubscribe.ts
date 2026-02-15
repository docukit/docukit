/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { ServerConnectionSocket } from "../../shared/types.js";
import type { DocSyncServer } from "../index.js";

export type UnsubscribeDocRequest = { docId: string };
export type UnsubscribeDocResponse = { success: boolean };
export type UnsubscribeDocHandler = (
  payload: UnsubscribeDocRequest,
  cb: (res: UnsubscribeDocResponse) => void,
) => void | Promise<void>;

type UnsubscribeDeps = {
  server: DocSyncServer;
  socket: ServerConnectionSocket<{}, {}>;
  clientId: string;
};

export function handleUnsubscribeDoc({
  server,
  socket,
  clientId,
}: UnsubscribeDeps): void {
  const socketToDocsMap = server["_socketToDocsMap"];
  const presenceByDoc = server["_presenceByDoc"];

  const handler: UnsubscribeDocHandler = async (
    { docId }: UnsubscribeDocRequest,
    cb: (res: UnsubscribeDocResponse) => void,
  ): Promise<void> => {
    await socket.leave(`doc:${docId}`);

    const subscribedDocs = socketToDocsMap.get(socket.id);
    if (subscribedDocs) {
      subscribedDocs.delete(docId);
      if (subscribedDocs.size === 0) {
        socketToDocsMap.delete(socket.id);
      }
    }

    const presenceForDoc = presenceByDoc.get(docId);
    if (presenceForDoc) {
      if (presenceForDoc[clientId] !== undefined) {
        socket.to(`doc:${docId}`).emit("presence", {
          docId,
          presence: { [clientId]: null },
        });
      }
      delete presenceForDoc[clientId];
      if (Object.keys(presenceForDoc).length === 0) {
        presenceByDoc.delete(docId);
      }
    }

    cb({ success: true });
  };

  socket.on("unsubscribe-doc", handler);
}
