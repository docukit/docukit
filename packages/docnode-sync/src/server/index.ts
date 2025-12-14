import { Server, type Socket } from "socket.io";
import type { Operations } from "docnode";
import type { SharedWith } from "../client/indexNode.js";
import type { DocNodeDB } from "../client/providers/indexeddb.js";

export type ClientToServerEvents = {
  push: (
    operations: DocNodeDB["operations"]["value"][],
    cb: (res: Operations | Error) => void,
  ) => void;
};

export type ServerToClientEvents = {
  world: () => void;
};

export type ServerProvider = {
  saveOperations: (operations: Operations) => Promise<void>;
};

type DocId = string;
type ClientId = string;

export class DocNodeServer {
  private _io: Server<ClientToServerEvents, ServerToClientEvents>;
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

  constructor(config: { port: number; provider: new () => ServerProvider }) {
    this._io = new Server(config.port, {
      cors: {
        origin: "*",
      },
    });
    this._provider = new config.provider();
    this._setupSocketServer();
    console.log(`Socket.io server listening on ${config.port}`);
  }

  private _setupSocketServer() {
    // prettier-ignore
    this._io.on("connection", (socket) => {
      const auth = socket.handshake.auth as { userId: string; token: string };
      // TODO: check token
      // 2. obtener el indexDoc del userId

      console.log("Client connected", auth);
      socket.on("disconnect", reason => console.log(`Client disconnected: ${reason}`));
      socket.on("error", err => console.error("Socket.io error:", err));
      socket.on("push", async (operations, cb) => {        
        // 1. In the same SQL operation, save the operations and 
        // obtain the ones that the client was missing, if any.
        
        // 2. If there are users connected to that document, broadcast the operations
        // if they are missing only those (or send the entire document otherwise)

        // 3. To the client who sent it, we respond with the operations that he was missing, obtained in point 1
        cb(operations);
      });
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
      sharedWith: SharedWith;
    };
  };
};
