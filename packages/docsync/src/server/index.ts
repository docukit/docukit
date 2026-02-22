import { Server } from "socket.io";
import type { Presence } from "../shared/types.js";
import type { ServerConfig, ServerSocket } from "./types.js";
import type { ServerEventMap, ServerEventName } from "./utils/events.js";
import { handleAuthenticationAndConnection } from "./handlers/connection/authenticationAndConnection.js";
import { createServerEventEmitter } from "./utils/events.js";
import { handleDisconnect } from "./handlers/connection/disconnect.js";
import { handlePresence } from "./handlers/presence.js";
import { handleSync } from "./handlers/sync/handleSync.js";
import { handleUnsubscribeDoc } from "./handlers/unsubscribe.js";
import { authorizeMiddleware } from "./utils/authorizeMiddleware.js";
// import { rateLimitMiddleware } from "./utils/rateLimitMiddleware.js";

export class DocSyncServer<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
> {
  private _io: ServerSocket<S, O, TContext>;
  // Track presence state per document: docId -> Record<clientId, presence data>
  private _presenceByDoc = new Map<string, Presence>();
  // Track which sockets are subscribed to which documents (for cleanup on disconnect)
  private _socketToDocsMap = new Map<string, Set<string>>();

  private _events = createServerEventEmitter<TContext, O, S>();

  constructor(config: ServerConfig<TContext, D, S, O>) {
    const { docBinding, authorize, authenticate, port } = config;
    this._io = new Server(port ?? 8080, {
      cors: { origin: "*" },
      transports: ["websocket"], // Performance: only ws, no polling
    });

    // Setup socket server
    const server = this;

    // Middlewares
    // rateLimitMiddleware(server);
    authorizeMiddleware(server, authorize);

    // Handlers
    handleAuthenticationAndConnection(server, authenticate);
    handleDisconnect({ server });
    handleSync({ server, provider: new config.provider(), docBinding });
    handleUnsubscribeDoc({ server });
    handlePresence({ server });
  }

  /**
   * Close the server and all connections.
   */
  async close(): Promise<void> {
    await this._io.close();
  }

  /**
   * Register a listener for an event. Returns an unsubscribe function.
   */
  on<K extends ServerEventName>(
    event: K,
    listener: (payload: ServerEventMap<TContext, O, S>[K]) => void,
  ): () => void {
    return this._events.on(
      event,
      listener as (
        payload: ServerEventMap<TContext, O, S>[ServerEventName],
      ) => void,
    );
  }
}
