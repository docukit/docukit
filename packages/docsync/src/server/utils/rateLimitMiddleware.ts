import type {
  DocSyncEventName,
  PresenceResponse,
  SyncResponse,
  UnsubscribeDocResponse,
} from "../../shared/types.js";
import type { DocSyncServer } from "../index.js";

const RATE_LIMIT_WINDOW_MS = 50;

/**
 * Registers a per-user, per-endpoint 50ms hard rate limit for this server.
 */
export function rateLimitMiddleware<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(server: DocSyncServer<TContext, D, S, O>): void {
  const endpointLastHitAtMap = new Map<string, number>();
  const io = server["_io"];

  io.on("connection", (socket) => {
    const { userId } = socket.data;

    socket.use((packet, next) => {
      const [eventName] = packet;
      if (!isDocSyncEndpoint(eventName)) {
        next();
        return;
      }

      // Rate-limit key is per user and per endpoint.
      const key = `${userId}:${eventName}`;
      const now = Date.now();
      const lastHitAt = endpointLastHitAtMap.get(key);

      // Hard reject requests that arrive inside the 50ms cooldown window.
      if (lastHitAt !== undefined && now - lastHitAt < RATE_LIMIT_WINDOW_MS) {
        rejectPacket(packet, eventName);
        return;
      }

      endpointLastHitAtMap.set(key, now);
      next();
    });
  });
}

function rejectPacket(packet: unknown[], eventName: DocSyncEventName): void {
  const maybeAck = packet.at(-1);

  if (eventName === "sync") {
    if (!isAckFn<SyncResponse>(maybeAck)) return;
    maybeAck({
      error: { type: "NetworkError", message: "Rate limit exceeded" },
    });
    return;
  }

  if (eventName === "presence") {
    if (!isAckFn<PresenceResponse>(maybeAck)) return;
    maybeAck({
      error: { type: "NetworkError", message: "Rate limit exceeded" },
    });
    return;
  }

  if (eventName === "unsubscribe-doc") {
    if (!isAckFn<UnsubscribeDocResponse>(maybeAck)) return;
    maybeAck({
      error: { type: "NetworkError", message: "Rate limit exceeded" },
    });
  }
}

function isAckFn<T>(value: unknown): value is (payload: T) => void {
  return typeof value === "function";
}

function isDocSyncEndpoint(eventName: string): eventName is DocSyncEventName {
  return (
    eventName === "sync" ||
    eventName === "presence" ||
    eventName === "delete-doc" ||
    eventName === "unsubscribe-doc"
  );
}
