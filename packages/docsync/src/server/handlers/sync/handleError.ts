import type { SyncResponse } from "../../../shared/types.js";
import type { DocSyncServer } from "../../index.js";
import type { ServerConnectionSocket } from "../../types.js";

/**
 * Emits a sync request error event and calls the response callback with
 * a DatabaseError.
 */
export function handleError<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(
  server: DocSyncServer<TContext, D, S, O>,
  socket: ServerConnectionSocket<S, O, TContext>,
  opts: { docId: string; operations: O[] | "deleted"; clock: number },
  error: unknown,
  startTime: number,
  cb: (res: SyncResponse<S, O>) => void,
): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorEvent = { type: "DatabaseError" as const, message: errorMessage };
  const { userId, deviceId } = socket.data;

  server["_events"].emit("syncRequest", {
    userId,
    deviceId,
    socketId: socket.id,
    status: "error",
    req: { docId: opts.docId, operations: opts.operations, clock: opts.clock },
    error: {
      ...errorEvent,
      ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    },
    durationMs: Date.now() - startTime,
  });

  cb({ error: errorEvent });
}
