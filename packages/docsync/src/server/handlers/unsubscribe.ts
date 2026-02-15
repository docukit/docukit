import type { Presence } from "../../shared/types.js";

export type UnsubscribeDocRequest = { docId: string };
export type UnsubscribeDocResponse = { success: boolean };
export type UnsubscribeDocHandler = (
  payload: UnsubscribeDocRequest,
  cb: (res: UnsubscribeDocResponse) => void,
) => void | Promise<void>;

type UnsubscribeSocket = {
  id: string;
  on: (event: "unsubscribe-doc", handler: UnsubscribeDocHandler) => void;
  leave: (room: string) => void | Promise<void>;
  to: (room: string) => {
    emit: (
      event: "presence",
      payload: { docId: string; presence: Presence },
    ) => void;
  };
};

type UnsubscribeDeps = {
  socket: UnsubscribeSocket;
  clientId: string;
  socketToDocsMap: Map<string, Set<string>>;
  presenceByDoc: Map<string, Presence>;
};

export function handleUnsubscribeDoc({
  socket,
  clientId,
  socketToDocsMap,
  presenceByDoc,
}: UnsubscribeDeps): void {
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
