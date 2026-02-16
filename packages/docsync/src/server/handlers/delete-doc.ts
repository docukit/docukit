/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  DeleteDocRequest,
  DeleteDocResponse,
} from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";

export type DeleteDocHandler = (
  payload: DeleteDocRequest,
  cb: (res: DeleteDocResponse) => void,
) => void | Promise<void>;

export const handleDeleteDoc = <TContext = {}>({
  server,
  socket,
  userId,
  context,
}: {
  server: DocSyncServer<TContext>;
  socket: ServerConnectionSocket<{}, {}>;
  userId: string;
  context: TContext;
}): void => {
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
