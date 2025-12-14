import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../server/index.js";
import type { ClientProvider } from "../client/index.js";
import { IndexedDBProvider } from "../client/providers/indexeddb.js";
import type { Operations } from "docnode";

export class DocNodeWebsocketClient {
  private _socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private _clientProvider: ClientProvider = new IndexedDBProvider();

  private _pushInProgress = false;
  private _inLocalWaiting = false; // debería disparar un push al inicializar (quizás hay en local)

  constructor(url: string) {
    this._socket = io(url, {
      auth: {
        userId: "John Salchichon",
        token: "1234567890",
      },
    });
    this._setupSocketClient();
  }

  // prettier-ignore
  private _setupSocketClient() {
    this._socket.on("connect", () => console.log("Connected to Socket.io server"))
    this._socket.on("connect_error", err => console.error("Socket.io connection error:", err))
    this._socket.on("disconnect", reason => console.error("Socket.io disconnected:", reason))
   }

  async onLocalOperations(operations: Operations) {
    await this._clientProvider.saveOperations(operations);
    if (this._pushInProgress) this._inLocalWaiting = true;

    const pushOperations = async () => {
      if (this._pushInProgress) throw new Error("Push already in progress");
      this._pushInProgress = true;
      const allOperations = await this._clientProvider.getOperations();
      const [error, newOperations] =
        await this._pushOperationsToServer(allOperations);
      if (error) {
        // retry. Maybe I should consider throw the error depending on the error type
        // to avoid infinite loops
        this._pushInProgress = false;
        await pushOperations();
      } else {
        // TODO: como hago en deleteOperations de indexedDB si quizás mientras viajaba al servidor y volvía
        // hubo otras operaciones que escribieron en idb?
        // 2 stores? Almacenar el id de la última operación enviada?
        await this._clientProvider.mergeAndDeleteOperations(newOperations);
        this._pushInProgress = false;
        const shouldPushAgain = this._inLocalWaiting;
        this._inLocalWaiting = false;
        if (shouldPushAgain) await pushOperations();
      }
    };
    if (!this._pushInProgress) await pushOperations();
  }

  private async _pushOperationsToServer(
    operations: Operations,
  ): Promise<[Error, undefined] | [undefined, Operations]> {
    const response = await new Promise<Operations | Error>((resolve) => {
      this._socket.emit("push", operations, (res: Operations | Error) => {
        resolve(res);
      });
    });
    if (response instanceof Error) return [response, undefined];
    return [undefined, response];
  }
}
