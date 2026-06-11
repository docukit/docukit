import type {
  DeleteDocRequest,
  DeleteDocResponse,
} from "../../shared/types.js";
import type { ServerConnectionSocket } from "../types.js";
import type { DocSyncServer } from "../index.js";
import * as v from "valibot";
import { deleteDocRequestSchema } from "../../shared/validators/socketProtocol.js";
import { createValidationError } from "./validation.js";

export type DeleteDocHandler = (
  payload: DeleteDocRequest,
  cb: (res: DeleteDocResponse) => void,
) => void | Promise<void>;

export const handleDeleteDoc = <
  TContext extends object = object,
  S extends object = object,
  O extends object = object,
>({
  server,
  socket,
}: {
  server: DocSyncServer<TContext, S, O>;
  socket: ServerConnectionSocket<TContext, S, O>;
}): void => {
  socket.on("delete-doc", async (rawReq: unknown, cb) => {
    let req: DeleteDocRequest;
    try {
      req = v.parse(deleteDocRequestSchema, rawReq);
    } catch (error) {
      cb({ error: createValidationError(error) });
      return;
    }

    const { userId, context } = socket.data;
    const authorized = server["_authorize"]
      ? await server["_authorize"]({ type: "delete-doc", req, userId, context })
      : true;
    if (!authorized) {
      cb({ error: { type: "AuthorizationError", message: "Access denied" } });
      return;
    }
    cb({ data: void undefined });
  });
};
