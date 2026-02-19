/* eslint-disable @typescript-eslint/no-empty-object-type */
import { Server } from "socket.io";
import type { DocBinding, Presence } from "../shared/types.js";
import type { ServerConfig, ServerProvider, ServerSocket } from "./types.js";
import type { ServerEventMap, ServerEventName } from "./utils/events.js";
import { handleAuthAndConnect } from "./handlers/connection/authAndConnect.js";
import { createServerEventEmitter } from "./utils/events.js";
import { handleDeleteDoc } from "./handlers/deleteDoc.js";
import { handleDisconnect } from "./handlers/connection/disconnect.js";
import { handlePresence } from "./handlers/presence.js";
import { handleSync } from "./handlers/sync/handleSync.js";
import { handleUnsubscribeDoc } from "./handlers/unsubscribe.js";

export class DocSyncServer<
  TContext = {},
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
> {
  private _io: ServerSocket<S, O, TContext>;
  private _docBinding: DocBinding<D, S, O>;
  private _provider: ServerProvider<S, O>;
  private _authenticate: ServerConfig<TContext, D, S, O>["authenticate"];
  private _authorize?: ServerConfig<TContext, D, S, O>["authorize"];
  // TODO: see comment in sync
  private _LRUCache = new Map<string, { deviceId: string; clock: number }>();
  // Track presence state per document: docId -> Record<clientId, presence data>
  private _presenceByDoc = new Map<string, Presence>();
  // Track which sockets are subscribed to which documents (for cleanup on disconnect)
  private _socketToDocsMap = new Map<string, Set<string>>();

  private _events = createServerEventEmitter<TContext, O, S>();

  constructor(config: ServerConfig<TContext, D, S, O>) {
    this._io = new Server(config.port ?? 8080, {
      cors: { origin: "*" },
      // Performance: Only WebSocket transport, no polling
      transports: ["websocket"],
    });

    this._docBinding = config.docBinding;
    this._provider = new config.provider();
    this._authenticate = config.authenticate.bind(config);
    this._authorize = config.authorize?.bind(config);

    // Setup socket server
    const server = this;
    handleAuthAndConnect(server, (socket) => {
      handleDisconnect({ server, socket });
      handleSync({ server, socket });
      handleUnsubscribeDoc({ server, socket });
      handlePresence({ server, socket });
      handleDeleteDoc({ server, socket });
    });
  }

  /**
   * Close the server and all connections.
   */
  async close(): Promise<void> {
    await this._io.close();
  }

  // ============================================================================
  // Event Registration
  // ============================================================================

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
