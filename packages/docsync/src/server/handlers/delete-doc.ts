import type { DocSyncServer } from "../index.js";

export type DeleteDocRequest = { docId: string };
export type DeleteDocResponse = { success: boolean };
export type DeleteDocHandler = (
  payload: DeleteDocRequest,
  cb: (res: DeleteDocResponse) => void,
) => void | Promise<void>;

type DeleteDocSocket = {
  on: (event: "delete-doc", handler: DeleteDocHandler) => void;
};

type DeleteDocDeps<TContext> = {
  server: DocSyncServer<TContext>;
  socket: DeleteDocSocket;
  userId: string;
  context: TContext;
};

export const handleDeleteDoc = <TContext>({
  server,
  socket,
  userId,
  context,
}: DeleteDocDeps<TContext>): void => {
  const authorize = server["_authorize"];
  const authorizeDeleteDoc = async (
    payload: DeleteDocRequest,
  ): Promise<boolean> => {
    if (!authorize) return true;
    return authorize({
      type: "delete-doc",
      payload,
      userId,
      context,
    });
  };

  const handler: DeleteDocHandler = async (payload, cb) => {
    const authorized = await authorizeDeleteDoc(payload);
    if (!authorized) {
      cb({ success: false });
      return;
    }
    cb({ success: true });
  };

  socket.on("delete-doc", handler);
};
