import { IndexedDBProvider, type DocNodeDB } from "./providers/indexeddb.js";
import { Doc, type Operations } from "docnode";
import { type DocConfig, type JsonDoc } from "docnode";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "../server/index.js";
import { io, type Socket } from "socket.io-client";

export type BroadcastMessage = {
  type: "OPERATIONS";
  operations: Operations;
  docId: string;
};

export type ClientConfig = {
  url: string;
  userId: string;
  docConfigs: DocConfig[];
};

export type ClientProvider = {
  getJsonDoc(docId: string): Promise<JsonDoc>;
  saveOnChange(doc: Doc, afterSave: () => void): Promise<void>;
  getOperations(): Promise<DocNodeDB["operations"]["value"][]>;
  deleteOperations(count: number): Promise<void>;
  saveOperations(operations: Operations, docId: string): Promise<void>;
  saveJsonDoc(json: JsonDoc, docId: string): Promise<void>;
};

type DocsCacheEntry = {
  promisedDoc: Promise<Doc>;
  refCount: number;
};

export class DocNodeClient {
  private _docsCache = new Map<string, DocsCacheEntry>();
  private _provider: ClientProvider = new IndexedDBProvider();
  private _docConfigs = new Map<string, DocConfig>();
  private _shouldBroadcast = true;
  private _broadcastChannel: BroadcastChannel;

  // ws
  private _socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private _pushInProgress = false;
  private _inLocalWaiting = false; // debería disparar un push al inicializar (quizás hay en local)

  constructor(config: ClientConfig) {
    if (typeof window === "undefined")
      throw new Error("DocNodeClient can only be used in the browser");
    const { docConfigs } = config;
    docConfigs.forEach((docConfig) => {
      const namespace = docConfig.namespace ?? "";
      if (this._docConfigs.has(namespace)) {
        throw new Error(`Duplicate namespace: ${namespace}`);
      }
      this._docConfigs.set(namespace, docConfig);
    });

    this._socket = io(config.url, {
      auth: {
        userId: "John Salchichon",
        token: "1234567890",
      },
    });
    // prettier-ignore
    {
    this._socket.on("connect", () => console.log("Connected to Socket.io server"));
    this._socket.on("connect_error", err => console.error("Socket.io connection error:", err));
    this._socket.on("disconnect", reason => console.error("Socket.io disconnected:", reason));
    }

    // Listen for operations from other tabs.
    this._broadcastChannel = new BroadcastChannel("docnode-sync");
    this._broadcastChannel.onmessage = async (
      ev: MessageEvent<BroadcastMessage>,
    ) => {
      if (ev.data.type === "OPERATIONS") {
        void this.applyOperations(ev.data.operations, ev.data.docId);
        return;
      }
      ev.data.type satisfies never;
    };
  }

  async applyOperations(operations: Operations, docId: string) {
    const docFromCache = this._docsCache.get(docId);
    if (!docFromCache) return;
    const doc = await docFromCache.promisedDoc;
    this._shouldBroadcast = false;
    doc.applyOperations(operations);
  }

  /**
   * Load a document from the cache or from the provider (E.g. IndexedDB).
   */
  async getDoc(docId: string): Promise<Doc> {
    const cacheEntry = this._docsCache.get(docId);
    if (cacheEntry) {
      cacheEntry.refCount += 1;
      return cacheEntry.promisedDoc;
    }

    const docPromise = this._loadDoc(docId);
    this._docsCache.set(docId, { promisedDoc: docPromise, refCount: 1 });
    return docPromise;
  }

  /**
   * Load a document from the provider (E.g. IndexedDB).
   * Create a listener to:
   * - save the operations to the provider (E.g. IndexedDB).
   * - send the operations to the broadcast channel for tab-synchronization.
   */
  private async _loadDoc(docId: string): Promise<Doc> {
    const jsonNodes = await this._provider.getJsonDoc(docId);
    const namespace = JSON.parse(jsonNodes[2].namespace ?? "") as string;
    const docConfig = this._docConfigs.get(namespace);
    if (!docConfig) {
      throw new Error(`Unknown namespace: ${namespace}`);
    }
    const doc = Doc.fromJSON(docConfig, jsonNodes);

    doc.onChange(({ operations }) => {
      if (this._shouldBroadcast) {
        this._sendMessage({ type: "OPERATIONS", operations, docId });
        void this.onLocalOperations(operations, doc.root.id);
      }
      this._shouldBroadcast = true;
    });
    return doc;
  }

  /**
   * Decrease the reference count of a document and, if it is 0, delete the document from the cache.
   */
  async _unloadDoc(docId: string) {
    const cacheEntry = this._docsCache.get(docId);
    if (!cacheEntry) return;
    if (cacheEntry.refCount > 1) cacheEntry.refCount -= 1;
    else {
      this._docsCache.delete(docId);
      const doc = await cacheEntry.promisedDoc;
      // TODO: maybe doc should have a destroy method?
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      doc["_changeListeners"].clear();
    }
  }

  _sendMessage(message: BroadcastMessage) {
    this._broadcastChannel.postMessage(message);
  }

  async onLocalOperations(operations: Operations, docId: string) {
    await this._provider.saveOperations(operations, docId);
    if (this._pushInProgress) this._inLocalWaiting = true;

    const pushOperations = async () => {
      if (this._pushInProgress) throw new Error("Push already in progress");
      this._pushInProgress = true;
      const allOperations = await this._provider.getOperations();
      // Acá puedo llegar a tener que devolver el documento completo si hubo concurrencia
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
        await this._provider.deleteOperations(allOperations.length);
        const doc = await this.getDoc(docId);
        const json = doc.toJSON();
        await this._provider.saveJsonDoc(json, docId);

        this._pushInProgress = false;
        const shouldPushAgain = this._inLocalWaiting;
        this._inLocalWaiting = false;
        if (shouldPushAgain) await pushOperations();
      }
    };
    if (!this._pushInProgress) await pushOperations();
  }

  private async _pushOperationsToServer(
    operations: DocNodeDB["operations"]["value"][],
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
