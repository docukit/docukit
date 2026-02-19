/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncRequest, SyncResponse } from "../../../shared/types.js";
import type { DocSyncServer } from "../../index.js";
import type { ServerConnectionSocket } from "../../types.js";

/**
 * Runs sync authorization. If not authorized, emits the error event, calls
 * the response callback with the error, and returns false. Otherwise returns true.
 */
export async function authorize<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(
  server: DocSyncServer<TContext, D, S, O>,
  socket: ServerConnectionSocket<S, O, TContext>,
  opts: { payload: SyncRequest<O>; startTime: number },
  cb: (res: SyncResponse<S, O>) => void,
): Promise<boolean> {
  const { payload, startTime } = opts;
  const { userId, deviceId, context } = socket.data;
  const socketId = socket.id;

  const authorized = server["_authorize"]
    ? await server["_authorize"]({ type: "sync", payload, userId, context })
    : true;

  if (!authorized) {
    const errorEvent = {
      type: "AuthorizationError" as const,
      message: "Access denied",
    };

    server["_events"].emit("syncRequest", {
      userId,
      deviceId,
      socketId,
      status: "error",
      req: payload,
      error: errorEvent,
      durationMs: Date.now() - startTime,
    });

    cb({ error: errorEvent });
    return false;
  }

  return true;
}
