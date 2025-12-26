/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { OpsPayload } from "../shared/types.js";
import type { DocBinding, SerializedDoc } from "../shared/docBinding.js";
import type {
  BroadcastMessage,
  ClientConfig,
  ClientProvider,
  DocData,
  GetDocArgs,
  QueryResult,
} from "./types.js";
import { ServerSync } from "./serverSync.js";

export class DocSyncClient<
  D extends {},
  S extends SerializedDoc,
  O extends {},
> {
  private _docBinding: DocBinding<D, S, O>;
  private _docsCache = new Map<
    string,
    { promisedDoc: Promise<D | undefined>; clock: number; refCount: number }
  >();
  private _local?: {
    provider: ClientProvider<S, O>;
    secret: Promise<string>;
  };
  private _shouldBroadcast = true;
  private _broadcastChannel: BroadcastChannel;
  private _serverSync?: ServerSync<D, S, O>;

  constructor(config: ClientConfig<D, S, O>) {
    if (typeof window === "undefined")
      throw new Error("DocSyncClient can only be used in the browser");
    const { docBinding, local } = config;
    this._docBinding = docBinding;
    if (local) {
      const provider = new local.provider() as ClientProvider<S, O>;
      this._local = {
        secret: local.getIdentity().then((identity) => identity.secret),
        provider,
      };
      this._serverSync = new ServerSync({
        provider,
        url: config.url,
        docBinding: this._docBinding,
      });
    }

    // Listen for operations from other tabs.
    this._broadcastChannel = new BroadcastChannel("docsync");
    this._broadcastChannel.onmessage = async (
      ev: MessageEvent<BroadcastMessage<O>>,
    ) => {
      // RECEIVED MESSAGES
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
        clock: 0,
        refCount: 1,
      });
      this._setupChangeListener(doc, id, emit);
      emit({ status: "success", data: { doc, id }, error: undefined });
      void this._local?.provider.saveSerializedDoc({
        serializedDoc: this._docBinding.serialize(doc),
        docId: id,
        clock: 0,
      });
      // This forces a fetch if the document exists on the server.
      void this.onLocalOperations({
        docId: id,
        operations: [] as unknown as O,
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
            this._docsCache.set(docId, { promisedDoc, clock: 0, refCount: 1 });
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
        void this.onLocalOperations({ docId, operations });
      }
      this._shouldBroadcast = true;
      emit({ status: "success", data: { doc, id: docId }, error: undefined });
    });
  }

  private async _loadOrCreateDoc(
    docId: string,
    namespace?: string,
  ): Promise<D | undefined> {
    // Try to load existing doc
    const serializedDoc = (await this._local?.provider.getSerializedDoc(docId))
      ?.serializedDoc;
    const localOperations = await this._local?.provider.getOperations({
      docId,
    });
    if (serializedDoc) {
      const doc = this._docBinding.deserialize(serializedDoc);
      this._shouldBroadcast = false;
      localOperations?.forEach((operations) => {
        this._docBinding.applyOperations(doc, operations);
      });
      this._shouldBroadcast = true;
      return doc;
    }

    // Create new doc if namespace provided
    if (namespace) {
      const { doc } = this._docBinding.new(namespace, docId);
      this._shouldBroadcast = false;
      if (localOperations?.length)
        throw new Error(
          `Doc ${docId} has operations stored locally but no serialized doc found`,
        );
      this._shouldBroadcast = true;
      // Save the new doc to IDB
      void this._local?.provider.saveSerializedDoc({
        serializedDoc: this._docBinding.serialize(doc),
        docId,
        clock: 0,
      });
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
    this._serverSync?.onSaved({ docId });
  }
}
