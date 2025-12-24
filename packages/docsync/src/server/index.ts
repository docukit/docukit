import { Server, type Socket } from "socket.io";
import {
  type ServerSocket,
  type SocketHandlers,
  type DocSyncEventName,
} from "../shared/types.js";
import type { ServerConfig, ServerProvider } from "./types.js";

export class DocSyncServer<TContext, S, O> {
  private _io: ServerSocket<S, O>;
  private _provider: ServerProvider<S, O>;

  constructor(config: ServerConfig<TContext, S, O>) {
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
        "sync-operations": (payload, cb) => {
          void this._provider.sync(payload).then(cb);
        },
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
