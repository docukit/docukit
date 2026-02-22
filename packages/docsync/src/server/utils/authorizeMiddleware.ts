import type {
  PresenceResponse,
  SyncRequest,
  SyncResponse,
} from "../../shared/types.js";
import type { DocSyncServer } from "../index.js";

export function authorizeMiddleware<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(server: DocSyncServer<TContext, D, S, O>): void {
  const io = server["_io"];

  io.on("connection", (socket) => {
    socket.use((packet, next) => {
      void (async () => {
        const rawPacket: unknown[] = packet as unknown[];
        const [eventName, payload, maybeAck] = rawPacket;
        if (eventName !== "sync" && eventName !== "presence") {
          next();
          return;
        }

        const authorize = server["_authorize"];
        if (!authorize) {
          next();
          return;
        }

        const { userId, context, deviceId } = socket.data;
        const startTime = Date.now();
        const authorized = await authorize({
          type: eventName,
          payload,
          userId,
          context,
        });

        if (authorized) {
          next();
          return;
        }

        if (eventName === "sync") {
          const errorEvent = {
            type: "AuthorizationError" as const,
            message: "Access denied",
          };
          const req = getSyncEventReq(payload);
          server["_events"].emit("syncRequest", {
            userId,
            deviceId,
            socketId: socket.id,
            status: "error",
            req,
            error: errorEvent,
            durationMs: Date.now() - startTime,
          });

          if (isAckFn<SyncResponse<S, O>>(maybeAck)) {
            maybeAck({ error: errorEvent });
          }
          return;
        }

        if (isAckFn<PresenceResponse>(maybeAck)) {
          maybeAck({
            error: { type: "AuthorizationError", message: "Access denied" },
          });
        }
      })().catch((error: unknown) => {
        next(error instanceof Error ? error : new Error(String(error)));
      });
    });
  });
}

function isAckFn<T>(value: unknown): value is (payload: T) => void {
  return typeof value === "function";
}

function isSyncRequest<O>(value: unknown): value is SyncRequest<O> {
  if (!value || typeof value !== "object") return false;
  const maybe = value as { docId?: unknown; clock?: unknown };
  return typeof maybe.docId === "string" && typeof maybe.clock === "number";
}

function getSyncEventReq(payload: unknown): { docId: string; clock: number } {
  if (!isSyncRequest(payload)) return { docId: "unknown", clock: 0 };
  return { docId: payload.docId, clock: payload.clock };
}
