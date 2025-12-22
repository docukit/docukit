/* eslint-disable @typescript-eslint/no-empty-object-type */
import type {
  ClientSocket,
  OpsPayload,
  SerializedDocPayload,
} from "../shared/types.js";
import { io } from "socket.io-client";
import type { DocBinding, SerializedDoc } from "../shared/docBinding.js";

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

export type DocData<D> = { doc: D; id: string };

export type QueryResult<D> =
  | {
      status: "loading";
      data: undefined;
      error: undefined;
    }
  | {
      status: "success";
      data: D;
      error: undefined;
    }
  | {
      status: "error";
      data: undefined;
      error: Error;
    };

export type BroadcastMessage<O> = {
  type: "OPERATIONS";
  operations: O;
  docId: string;
};

export type ClientConfig<
  D extends {},
  S extends SerializedDoc,
  O extends {},
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
  D extends {},
  S extends SerializedDoc,
  O extends {},
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
      auth: { userId: "John", token: "1234567890" },
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
        console.log("sending", ev.data.operations[0]);
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
   * Subscribe to a document with reactive state updates.
   *
   * The behavior depends on which fields are provided:
   * - `{ namespace, id }` → Try to get an existing doc. Returns `undefined` if not found.
   * - `{ namespace, createIfMissing: true }` → Create a new doc with auto-generated ID (ulid).
   * - `{ namespace, id, createIfMissing: true }` → Get existing doc or create it if not found.
   *
   * The callback will be invoked with state updates:
   * 1. `{ status: "loading" }` - Initial state while fetching
   * 2. `{ status: "success", data: { doc, id } }` - Document loaded successfully
   * 3. `{ status: "error", error }` - Failed to load document
   *
   * Subsequent updates will be sent whenever the document changes.
   *
   * @example
   * ```ts
   * // Subscribe to doc changes
   * const unsubscribe = client.getDoc(
   *   { namespace: "notes", id: "abc123" },
   *   (result) => {
   *     if (result.status === "loading") console.log("Loading...");
   *     if (result.status === "success") console.log("Doc:", result.data.doc);
   *     if (result.status === "error") console.error(result.error);
   *   }
   * );
   *
   * // Clean up when done
   * unsubscribe();
   * ```
   */
  getDoc<T extends GetDocArgs>(
    args: T,
    callback: (
      result: QueryResult<
        T extends { createIfMissing: true }
          ? DocData<D>
          : DocData<D> | undefined
      >,
    ) => void,
  ): () => void {
    const namespace = args.namespace;
    const argId = "id" in args ? args.id : undefined;
    const createIfMissing = "createIfMissing" in args && args.createIfMissing;
    // Internal emit uses wider type; runtime logic ensures correct data per overload
    const emit = callback as (
      result: QueryResult<DocData<D> | undefined>,
    ) => void;
    let docId: string | undefined;

    // Case: { namespace, createIfMissing: true } → Create new doc with auto-generated ID (sync).
    if (!argId && createIfMissing) {
      const { doc, id } = this._docBinding.new(namespace);
      docId = id;
      this._docsCache.set(id, {
        promisedDoc: Promise.resolve(doc),
        refCount: 1,
      });
      this._setupChangeListener(doc, id, emit);
      emit({ status: "success", data: { doc, id }, error: undefined });
      void this._local?.provider.saveSerializedDoc({
        serializedDoc: this._docBinding.serialize(doc),
        docId: id,
      });
      return () => void this._unloadDoc(id);
    }

    // Preparing for the async cases
    emit({ status: "loading", data: undefined, error: undefined });

    // Case: { namespace, id } or { namespace, id, createIfMissing } → Load or create (async).
    if (argId) {
      docId = argId;
      void (async () => {
        try {
          let doc: D | undefined;
          const cacheEntry = this._docsCache.get(docId);
          if (cacheEntry) {
            cacheEntry.refCount += 1;
            doc = await cacheEntry.promisedDoc;
          } else {
            const promisedDoc = this._loadOrCreateDoc(
              docId,
              createIfMissing ? namespace : undefined,
            );
            this._docsCache.set(docId, { promisedDoc, refCount: 1 });
            doc = await promisedDoc;
            // Register listener only for new docs (not cache hits)
            if (doc) this._setupChangeListener(doc, docId, emit);
          }
          emit({
            status: "success",
            data: doc ? { doc, id: docId } : undefined,
            error: undefined,
          });
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          emit({ status: "error", data: undefined, error });
          throw error;
        }
      })();
    }

    return () => {
      if (docId) void this._unloadDoc(docId);
    };
  }

  private _setupChangeListener(
    doc: D,
    docId: string,
    emit: (result: QueryResult<DocData<D> | undefined>) => void,
  ) {
    this._docBinding.onChange(doc, ({ operations }) => {
      if (this._shouldBroadcast) {
        this._sendMessage({ type: "OPERATIONS", operations, docId });
        void this.onLocalOperations({ docId, operations, doc });
      }
      this._shouldBroadcast = true;
      emit({ status: "success", data: { doc, id: docId }, error: undefined });
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

  async onLocalOperations({
    docId,
    operations,
    doc,
  }: OpsPayload<O> & { doc: D }) {
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
        await this._local?.provider.saveSerializedDoc({
          serializedDoc: this._docBinding.serialize(doc),
          docId,
        });

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
