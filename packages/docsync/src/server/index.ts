import { Server, type Socket } from "socket.io";
import type { Operations } from "docnode";
import {
  type ServerSocket,
  type AuthorizeEvent,
  type SocketHandlers,
  type DocSyncEventName,
} from "../shared/types.js";

// Re-export AuthorizeEvent for consumers
export type { AuthorizeEvent } from "../shared/types.js";

// replace this with shared types
export type ServerProvider = {
  saveOperations: (operations: Operations) => Promise<void>;
};

/**
 * Server configuration with generic context type.
 *
 * @typeParam TContext - Application-defined context shape returned by authenticate
 *                       and passed to authorize. Defaults to empty object.
 */
export type ServerConfig<
  TContext = Record<string, unknown>,
  S = unknown,
  O = unknown,
> = {
  port?: number;
  provider: new () => ServerProvider;

  /**
   * Authenticates a WebSocket connection.
   *
   * - Called once per connection attempt.
   * - Must validate the provided token.
   * - Must resolve the canonical userId.
   * - May optionally return a context object that will be passed to authorize.
   *
   * @returns User info with optional context, or undefined if authentication fails.
   */
  authenticate: (ev: { token: string }) => Promise<
    | {
        userId: string;
        context?: TContext;
      }
    | undefined
  >;

  /**
   * Authorizes an operation.
   *
   * - Called for each operation (get-doc, apply-operations, create-doc, save-doc).
   * - Receives the cached context from authenticate.
   * - Can use cached context for fast checks or fetch fresh data for consistency.
   *
   * @returns true to allow, false to deny.
   */
  authorize?: (ev: AuthorizeEvent<TContext, S, O>) => Promise<boolean>;
};

type DocId = string;
type ClientId = string;

export class DocSyncServer<S, O> {
  private _io: ServerSocket<S, O>;
  private _provider: ServerProvider;
  /**
   * This are the docs that at least one client has in memory (open/active).
   * The clients in the value are ALL the clients who have access to the document, not just those who are connected.
   */
  private _activeDocs = new Map<
    DocId,
    {
      [clientId: string]: {
        accessType: "view" | "edit";
        localVersion: number;
      };
    }
  >();
  /**
   * This are the clients that are connected to the server.
   * The docs in the value are ONLY the docs that the client has active/in memory.
   */
  private _activeClients = new Map<
    ClientId,
    {
      sockets: Set<Socket>;
      activeDocs: Set<DocId>;
    }
  >();

  constructor(config: ServerConfig) {
    this._io = new Server(config.port ?? 8080, {
      cors: {
        origin: "*",
      },
    });
    this._provider = new config.provider();
    this._setupSocketServer();
    console.log(`Socket.io server listening on ${config.port}`);
  }

  private _setupSocketServer() {
    this._io.on("connection", (socket) => {
      const auth = socket.handshake.auth as { userId: string; token: string };
      console.log("Client connected", auth);
      socket.on("disconnect", (reason) =>
        console.log(`Client disconnected: ${reason}`),
      );
      socket.on("error", (err) => console.error("Socket.io error:", err));

      // TypeScript errors if any handler is missing
      const handlers: SocketHandlers<S, O> = {
        "get-doc": (_payload, cb) => cb(undefined),
        "sync-operations": (payload, cb) =>
          cb({ opsGroups: payload.opsGroups, clock: payload.clock }),
        "delete-doc": (_payload, cb) => cb({ success: true }),
      };

      // Register handlers
      for (const event of Object.keys(handlers) as DocSyncEventName[]) {
        socket.on(event, handlers[event]);
      }
    });
  }
}

/**
 * Although it shares many things with indexDoc, I am not going to use it because:
 * 1. I want it to be json serializable to share it with the server
 * 2. I find a simpler model to decouple these concepts (some things persist, others are awareness, etc.).
 */
type _ClientOrchestrator = {
  docs: {
    [docId: string]: {
      isInMemory: boolean;
      localVersion: number;
      serverVersion: number;
    };
  };
};
