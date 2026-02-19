/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncServer } from "../../index.js";
import type {
  AuthenticatedContext,
  ServerConnectionSocket,
} from "../../types.js";

/**
 * Sets up auth middleware, connection_error handling, and the connection
 * listener. Calls onConnect(socket) for each authenticated connection so
 * the caller can register socket handlers (handleDisconnect, handleSync, etc.).
 */
export function handleAuthAndConnect<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(
  server: DocSyncServer<TContext, D, S, O>,
  onConnect: (socket: ServerConnectionSocket<S, O, TContext>) => void,
): void {
  const io = server["_io"];
  const authenticate = server["_authenticate"];

  io.use((socket, next) => {
    const { token, deviceId, clientId } = socket.handshake.auth;
    if (!token || typeof token !== "string") {
      next(new Error("Authentication required: no token provided"));
      return;
    }

    if (!deviceId || typeof deviceId !== "string") {
      next(new Error("Device ID required"));
      return;
    }

    if (!clientId || typeof clientId !== "string" || clientId.length === 0) {
      next(new Error("Client ID required"));
      return;
    }

    authenticate({ token })
      .then((authResult) => {
        if (!authResult) {
          next(new Error("Authentication failed: invalid token"));
          return;
        }

        socket.data = {
          userId: authResult.userId,
          deviceId,
          clientId,
          context: authResult.context ?? ({} as TContext),
        } satisfies AuthenticatedContext<TContext>;

        next();
      })
      .catch((err: unknown) => {
        next(new Error(`Authentication error: ${String(err)}`));
      });
  });

  io.engine.on(
    "connection_error",
    (err: { req: { _query?: { deviceId?: string } }; message: string }) => {
      const deviceId = err.req._query?.deviceId ?? "unknown";
      server["_emit"](server["_clientDisconnectEventListeners"], {
        userId: "unknown",
        deviceId,
        socketId: "unknown",
        reason: `Authentication failed: ${err.message}`,
      });
    },
  );

  io.on("connection", (socket) => {
    const { userId, deviceId, context } = socket.data;

    server["_emit"](server["_clientConnectEventListeners"], {
      userId,
      deviceId,
      socketId: socket.id,
      context,
    });

    onConnect(socket);
  });
}
