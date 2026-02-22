import type {
  DocSyncEventName,
  PresenceResponse,
  SyncResponse,
  UnsubscribeDocResponse,
} from "../../shared/types.js";
import type { DocSyncServer } from "../index.js";

const RATE_LIMIT_WINDOW_MS = 50;

/**
 * Registers a per-user, per-endpoint 50ms throttle for this server.
 */
export function setRateLimits<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(server: DocSyncServer<TContext, D, S, O>): void {
  // This map is created once per server initialization and then shared by all
  // socket connections through closure, so the limit is user-based, not socket-based.
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
    if (!isAckFn<SyncResponse<unknown, unknown>>(maybeAck)) return;
    const payload: SyncResponse<unknown, unknown> = {
      error: { type: "NetworkError", message: "Rate limit exceeded" },
    };
    maybeAck(payload);
    return;
  }

  if (eventName === "presence") {
    if (!isAckFn<PresenceResponse>(maybeAck)) return;
    const payload: PresenceResponse = {
      error: { type: "NetworkError", message: "Rate limit exceeded" },
    };
    maybeAck(payload);
    return;
  }

  if (eventName === "unsubscribe-doc") {
    if (!isAckFn<UnsubscribeDocResponse>(maybeAck)) return;
    const payload: UnsubscribeDocResponse = {
      error: { type: "NetworkError", message: "Rate limit exceeded" },
    };
    maybeAck(payload);
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
