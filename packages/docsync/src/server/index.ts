import { Server, type Socket } from "socket.io";
import {
  type ServerSocket,
  type SocketHandlers,
  type DocSyncEventName,
} from "../shared/types.js";
import type { ServerConfig, ServerProvider } from "./types.js";

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
