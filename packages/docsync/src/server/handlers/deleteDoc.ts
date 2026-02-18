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

export const handleDeleteDoc = <
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>({
  server,
  socket,
}: {
  server: DocSyncServer<TContext, D, S, O>;
  socket: ServerConnectionSocket<S, O, TContext>;
}): void => {
  socket.on("delete-doc", async (payload, cb) => {
    const { userId, context } = socket.data;
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
