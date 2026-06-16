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
  TContext = unknown,
  D extends object = object,
  S extends object = object,
  O extends object = object,
>({
  server,
  socket,
  userId,
  context,
}: {
  server: DocSyncServer<TContext, D, S, O>;
  socket: ServerConnectionSocket<TContext, S, O>;
  userId: string;
  context: TContext;
}): void => {
  socket.on("delete-doc", async (req, cb) => {
    const authorized = server["_authorize"]
      ? await server["_authorize"]({ type: "delete-doc", req, userId, context })
      : true;
    if (!authorized) {
      cb({ success: false });
      return;
    }
    cb({ success: true });
  });
};
