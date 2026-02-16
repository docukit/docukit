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
  socket.on("delete-doc", async (payload, cb) => {
    const authorized = server["_authorize"]
      ? await server["_authorize"]({
          type: "delete-doc",
          payload,
          userId,
          context,
        })
      : true;
    if (!authorized) {
      cb({ success: false });
      return;
    }
    cb({ success: true });
  });
};
