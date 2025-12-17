import { Doc, type Operations } from "docnode";
import { type DocConfig, type JsonDoc } from "docnode";
import type {
  ClientSocket,
  JsonDocPayload,
  OpsPayload,
} from "../shared/types.js";
import { io } from "socket.io-client";

/**
 * Arguments for {@link DocNodeClient.getDoc}.
 *
 * - `{ namespace, id }` → Try to get an existing doc by ID. Returns `undefined` if not found.
 * - `{ namespace, createIfMissing: true }` → Create a new doc with auto-generated ID (ulid).
 * - `{ namespace, id, createIfMissing: true }` → Get existing doc or create it if not found.
 */
export type GetDocArgs =
  | { namespace: string; id: string; createIfMissing?: boolean }
  | { namespace: string; createIfMissing: true };

export type BroadcastMessage = {
  type: "OPERATIONS";
  operations: Operations;
  docId: string;
};

export type ClientConfig = {
  url: string;
  userId: string;
  docConfigs: DocConfig[];
  provider: new () => ClientProvider;
};

export type ClientProvider = {
  getJsonDoc(docId: string): Promise<JsonDocPayload | undefined>;
  getOperations(): Promise<OpsPayload[]>;
  deleteOperations(count: number): Promise<void>;
  saveOperations(operations: Operations, docId: string): Promise<void>;
  saveJsonDoc(json: JsonDocPayload): Promise<void>;
};

type DocsCacheEntry = {
  promisedDoc: Promise<Doc | undefined>;
  refCount: number;
};

export class DocNodeClient {
  private _docsCache = new Map<string, DocsCacheEntry>();
  private _provider: ClientProvider;
  private _docConfigs = new Map<string, DocConfig>();
  private _shouldBroadcast = true;
  private _broadcastChannel: BroadcastChannel;

  // ws
  private _socket: ClientSocket;
  private _pushInProgress = false;
  private _inLocalWaiting = false; // debería disparar un push al inicializar (quizás hay en local)

  constructor(config: ClientConfig) {
    if (typeof window === "undefined")
      throw new Error("DocNodeClient can only be used in the browser");
    const { docConfigs, provider } = config;
    this._provider = new provider();
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
        void this._applyOperations(ev.data.operations, ev.data.docId);
        return;
      }
      ev.data.type satisfies never;
    };
  }

  async _applyOperations(operations: Operations, docId: string) {
    const docFromCache = this._docsCache.get(docId);
    if (!docFromCache) return;
    const doc = await docFromCache.promisedDoc;
    if (!doc) return;
    this._shouldBroadcast = false;
    doc.applyOperations(operations);
  }

  /**
   * Get or create a document based on the provided arguments.
   *
   * The behavior depends on which fields are provided:
   * - `{ namespace, id }` → Try to get an existing doc. Returns `undefined` if not found.
   * - `{ namespace, createIfMissing: true }` → Create a new doc with auto-generated ID (ulid).
   * - `{ namespace, id, createIfMissing: true }` → Get existing doc or create it if not found.
   *
   * The returned doc is cached and has listeners for:
   * - Saving operations to the provider (e.g., IndexedDB).
   * - Broadcasting operations to other tabs for synchronization.
   *
   * @example
   * ```ts
   * // Get existing doc (might be undefined)
   * const doc = await client.getDoc({ namespace: "notes", id: "abc123" });
   *
   * // Create new doc with auto-generated ID
   * const newDoc = await client.getDoc({ namespace: "notes", createIfMissing: true });
   *
   * // Get or create (guaranteed to return a Doc)
   * const doc = await client.getDoc({ namespace: "notes", id: "abc123", createIfMissing: true });
   * ```
   */
  async getDoc(args: {
    namespace: string;
    id?: string;
    createIfMissing: true;
  }): Promise<Doc>;
  async getDoc(args: {
    namespace: string;
    id: string;
    createIfMissing?: false;
  }): Promise<Doc | undefined>;
  async getDoc(args: GetDocArgs): Promise<Doc | undefined> {
    const namespace = args.namespace;
    const id = "id" in args ? args.id : undefined;
    const createIfMissing = "createIfMissing" in args && args.createIfMissing;

    let promisedDoc: Promise<Doc | undefined>;

    if (!id && createIfMissing) {
      // Case: { namespace, createIfMissing: true } → Create new doc with auto-generated ID (ulid)
      const docConfig = this._docConfigs.get(namespace);
      if (!docConfig) throw new Error(`Unknown namespace: ${namespace}`);
      const doc = new Doc(docConfig);
      await this._provider.saveJsonDoc({ jsonDoc: doc.toJSON() });
      promisedDoc = Promise.resolve(doc);
      this._docsCache.set(doc.root.id, { promisedDoc, refCount: 1 });
    } else if (id) {
      // Case: { namespace, id } or { namespace, id, createIfMissing } → Try to get, optionally create
      const cacheEntry = this._docsCache.get(id);
      if (cacheEntry) {
        cacheEntry.refCount += 1;
        return cacheEntry.promisedDoc;
      }
      promisedDoc = this._loadOrCreateDoc(
        id,
        createIfMissing ? namespace : undefined,
      );
      this._docsCache.set(id, { promisedDoc, refCount: 1 });
    } else {
      return undefined;
    }

    // Setup change listener once doc is ready (single place)
    const doc = await promisedDoc;
    doc?.onChange(({ operations }) => {
      if (this._shouldBroadcast) {
        this._sendMessage({
          type: "OPERATIONS",
          operations,
          docId: doc.root.id,
        });
        void this.onLocalOperations(operations, doc.root.id);
      }
      this._shouldBroadcast = true;
    });
    return doc;
  }

  private async _loadOrCreateDoc(
    id: string,
    namespace?: string,
  ): Promise<Doc | undefined> {
    // Try to load existing doc
    const jsonDoc = (await this._provider.getJsonDoc(id))?.jsonDoc;
    if (jsonDoc) {
      const ns = JSON.parse(jsonDoc[2].namespace ?? "") as string;
      const docConfig = this._docConfigs.get(ns);
      if (!docConfig) throw new Error(`Unknown namespace: ${ns}`);
      const doc = Doc.fromJSON(docConfig, jsonDoc);
      doc.forceCommit();
      return doc;
    }

    // Create new doc if namespace provided
    if (namespace) {
      const docConfig = this._docConfigs.get(namespace);
      if (!docConfig) throw new Error(`Unknown namespace: ${namespace}`);
      const doc = new Doc({ ...docConfig, id });
      await this._provider.saveJsonDoc({ jsonDoc: doc.toJSON() });
      return doc;
    }

    return undefined;
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
      if (!doc) return;
      // TODO: maybe doc should have a destroy method?
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      doc["_changeListeners"].clear();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      doc["_normalizeListeners"].clear();
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
        // Get doc from cache directly (it's guaranteed to exist since it triggered this)
        const cacheEntry = this._docsCache.get(docId);
        const doc = cacheEntry ? await cacheEntry.promisedDoc : undefined;
        if (doc) {
          await this._provider.saveJsonDoc({ jsonDoc: doc.toJSON() });
        }

        this._pushInProgress = false;
        const shouldPushAgain = this._inLocalWaiting;
        this._inLocalWaiting = false;
        if (shouldPushAgain) await pushOperations();
      }
    };
    if (!this._pushInProgress) await pushOperations();
  }

  private async _pushOperationsToServer(
    ops: OpsPayload[],
  ): Promise<[Error, undefined] | [undefined, OpsPayload[]]> {
    const response = await new Promise<OpsPayload[] | Error>((resolve) => {
      this._socket.emit("operations", ops, (res: OpsPayload[] | Error) => {
        resolve(res);
      });
    });
    if (response instanceof Error) return [response, undefined];
    return [undefined, response];
  }
}
