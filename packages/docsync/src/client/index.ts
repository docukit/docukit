import type {
  ClientSocket,
  OpsPayload,
  SerializedDocPayload,
} from "../shared/types.js";
import { io } from "socket.io-client";
import type { DocBinding, SerializedDoc, NN } from "../shared/docBinding.js";

/**
 * Arguments for {@link DocSyncClient["getDoc"]}.
 *
 * - `{ namespace, id }` → Try to get an existing doc by ID. Returns `undefined` if not found.
 * - `{ namespace, createIfMissing: true }` → Create a new doc with auto-generated ID (ulid).
 * - `{ namespace, id, createIfMissing: true }` → Get existing doc or create it if not found.
 */
export type GetDocArgs =
  | { namespace: string; id: string; createIfMissing?: boolean }
  | { namespace: string; createIfMissing: true };

export type BroadcastMessage<O> = {
  type: "OPERATIONS";
  operations: O;
  docId: string;
};

export type ClientConfig<
  D extends NN,
  S extends SerializedDoc,
  O extends NN,
> = {
  url: string;
  docBinding: DocBinding<D, S, O>;
  auth: {
    /**
     * Server authentication token.
     *
     * - Passed verbatim to the server on connection.
     * - Validation is delegated to the server via `onAuth`.
     * - This library does not issue, refresh, or rotate tokens.
     */
    getToken: () => Promise<string>;
  };
  local?: {
    provider: new () => ClientProvider<S, O>;
    /**
     * Resolves the local storage identity.
     *
     * Used exclusively for:
     * - Namespacing local persistence (userId)
     * - Deriving encryption keys for data at rest (secret)
     *
     * About the secret:
     * - Must never be persisted client-side (localStorage, IndexedDB, etc).
     * - Re-encryption is not supported, so losing the secret makes local data permanently unrecoverable.
     *
     */
    getIdentity: () => Promise<{
      userId: string;
      secret: string;
    }>;
  };
};

export type ClientProvider<S, O> = {
  getSerializedDoc(docId: string): Promise<{ serializedDoc: S } | undefined>;
  getOperations(): Promise<OpsPayload<O>[]>;
  deleteOperations(count: number): Promise<void>;
  saveOperations(arg: OpsPayload<O>): Promise<void>;
  saveSerializedDoc(arg: SerializedDocPayload<S>): Promise<void>;
};

export class DocSyncClient<
  D extends NN,
  S extends SerializedDoc,
  O extends NN,
> {
  private _docBinding: DocBinding<D, S, O>;
  // prettier-ignore
  private _docsCache = new Map<string, { promisedDoc: Promise<D | undefined>; refCount: number; }>();
  private _local?: {
    provider: ClientProvider<S, O>;
    secret: Promise<string>;
  };
  private _shouldBroadcast = true;
  private _broadcastChannel: BroadcastChannel;

  // ws
  private _socket: ClientSocket<S, O>;
  protected _pushStatus: "idle" | "pushing" | "pushing-with-pending" = "idle";

  constructor(config: ClientConfig<D, S, O>) {
    if (typeof window === "undefined")
      throw new Error("DocSyncClient can only be used in the browser");
    const { docBinding, local } = config;
    this._docBinding = docBinding;
    if (local)
      this._local = {
        secret: local.getIdentity().then((identity) => identity.secret),
        provider: new local.provider(),
      };

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
    this._broadcastChannel = new BroadcastChannel("docsync");
    this._broadcastChannel.onmessage = async (
      ev: MessageEvent<BroadcastMessage<O>>,
    ) => {
      if (ev.data.type === "OPERATIONS") {
        void this._applyOperations(ev.data.operations, ev.data.docId);
        return;
      }
      ev.data.type satisfies never;
    };
  }

  async _applyOperations(operations: O, docId: string) {
    const docFromCache = this._docsCache.get(docId);
    if (!docFromCache) return;
    const doc = await docFromCache.promisedDoc;
    if (!doc) return;
    this._shouldBroadcast = false;
    this._docBinding.applyOperations(doc, operations);
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
  }): Promise<{ doc: D; id: string }>;
  async getDoc(args: {
    namespace: string;
    id: string;
    createIfMissing?: false;
  }): Promise<{ doc: D; id: string } | undefined>;
  async getDoc(args: GetDocArgs): Promise<{ doc: D; id: string } | undefined> {
    const namespace = args.namespace;
    const id = "id" in args ? args.id : undefined;
    const createIfMissing = "createIfMissing" in args && args.createIfMissing;

    // Case: { namespace, createIfMissing: true } → Create a new doc with auto-generated ID (ulid).
    if (!id && createIfMissing) {
      const { doc, id } = this._docBinding.new(namespace);
      const serializedDoc = this._docBinding.serialize(doc);
      await this._local?.provider.saveSerializedDoc({
        serializedDoc,
        docId: id,
      });
      this._setupChangeListener(doc, id);
      this._docsCache.set(id, {
        promisedDoc: Promise.resolve(doc),
        refCount: 1,
      });
      return { doc, id };
    } else if (id) {
      // Case: { namespace, id } or { namespace, id, createIfMissing } → Try to get, optionally create
      const cacheEntry = this._docsCache.get(id);
      if (cacheEntry) {
        cacheEntry.refCount += 1;
        return cacheEntry.promisedDoc.then((doc) =>
          doc ? { doc, id } : undefined,
        );
      }
      const promisedDoc = this._loadOrCreateDoc(
        id,
        createIfMissing ? namespace : undefined,
      );
      this._docsCache.set(id, { promisedDoc, refCount: 1 });
      const doc = await promisedDoc;
      if (!doc) return undefined;
      this._setupChangeListener(doc, id);
      return { doc, id };
    } else {
      return undefined;
    }
  }

  private _setupChangeListener(doc: D, docId: string) {
    this._docBinding.onChange(doc, ({ operations }) => {
      if (this._shouldBroadcast) {
        this._sendMessage({
          type: "OPERATIONS",
          operations,
          docId,
        });
        void this.onLocalOperations({ docId, operations });
      }
      this._shouldBroadcast = true;
    });
  }

  private async _loadOrCreateDoc(
    id: string,
    namespace?: string,
  ): Promise<D | undefined> {
    // Try to load existing doc
    const serializedDoc = (await this._local?.provider.getSerializedDoc(id))
      ?.serializedDoc;
    if (serializedDoc) {
      const doc = this._docBinding.deserialize(serializedDoc);
      return doc;
    }

    // Create new doc if namespace provided
    if (namespace) {
      const { doc } = this._docBinding.new(namespace, id);
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
      this._docBinding.removeListeners(doc);
    }
  }

  _sendMessage(message: BroadcastMessage<O>) {
    this._broadcastChannel.postMessage(message);
  }

  async onLocalOperations({ docId, operations }: OpsPayload<O>) {
    await this._local?.provider.saveOperations({ docId, operations });
    if (this._pushStatus !== "idle") this._pushStatus = "pushing-with-pending";

    const pushOperations = async () => {
      if (this._pushStatus !== "idle")
        throw new Error("Push already in progress");
      // prevent narrowing for security due to async mutation scenario. TS trade-off.
      // https://github.com/microsoft/TypeScript/issues/9998
      this._pushStatus = "pushing" as DocSyncClient<D, S, O>["_pushStatus"];
      const allOperations = (await this._local?.provider.getOperations()) ?? [];
      // Acá puedo llegar a tener que devolver el documento completo si hubo concurrencia
      const [error, _newOperations] =
        await this._pushOperationsToServer(allOperations);
      if (error) {
        // retry. Maybe I should consider throw the error depending on the error type
        // to avoid infinite loops
        this._pushStatus = "idle";
        await pushOperations();
      } else {
        // TODO: como hago en deleteOperations de indexedDB si quizás mientras viajaba al servidor y volvía
        // hubo otras operaciones que escribieron en idb?
        // 2 stores? Almacenar el id de la última operación enviada?
        await this._local?.provider.deleteOperations(allOperations.length);
        // Get doc from cache directly (it's guaranteed to exist since it triggered this)
        const cacheEntry = this._docsCache.get(docId);
        const doc = cacheEntry ? await cacheEntry.promisedDoc : undefined;
        if (doc) {
          await this._local?.provider.saveSerializedDoc({
            serializedDoc: this._docBinding.serialize(doc),
            docId,
          });
        }

        // Status may have changed to "pushing-with-pending" during async ops
        const shouldPushAgain = this._pushStatus === "pushing-with-pending";
        this._pushStatus = "idle";
        if (shouldPushAgain) await pushOperations();
      }
    };
    if (this._pushStatus === "idle") await pushOperations();
  }

  private async _pushOperationsToServer(
    ops: OpsPayload<O>[],
  ): Promise<[Error, undefined] | [undefined, OpsPayload<O>[]]> {
    const response = await new Promise<OpsPayload<O>[] | Error>((resolve) => {
      this._socket.emit("operations", ops, (res: OpsPayload<O>[] | Error) => {
        resolve(res);
      });
    });
    if (response instanceof Error) return [response, undefined];
    return [undefined, response];
  }
}
