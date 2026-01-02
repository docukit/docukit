/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocBinding, SerializedDoc } from "../shared/docBinding.js";
import type {
  BroadcastMessage,
  ClientConfig,
  ClientProvider,
  DocData,
  GetDocArgs,
  Identity,
  QueryResult,
} from "./types.js";
import { ServerSync } from "./serverSync.js";

type LocalResolved<S, O> = {
  provider: ClientProvider<S, O>;
  identity: Identity;
};

export class DocSyncClient<
  D extends {},
  S extends SerializedDoc,
  O extends {},
> {
  protected _docBinding: DocBinding<D, S, O>;
  protected _docsCache = new Map<
    string,
    { promisedDoc: Promise<D | undefined>; refCount: number }
  >();
  protected _localPromise?: Promise<LocalResolved<S, O>>;
  private _shouldBroadcast = true;
  protected _broadcastChannel?: BroadcastChannel;
  protected _serverSync?: ServerSync<D, S, O>;
  private _realTime: boolean;
  private _useBroadcastChannel: boolean;

  constructor(config: ClientConfig<D, S, O>) {
    if (typeof window === "undefined")
      throw new Error("DocSyncClient can only be used in the browser");
    const {
      docBinding,
      local,
      server,
      realTime = true,
      broadcastChannel = true,
    } = config;
    this._docBinding = docBinding;
    this._realTime = realTime;
    this._useBroadcastChannel = broadcastChannel;

    // Initialize local provider (if configured)
    if (local) {
      // Capture values for async context
      const _docBinding = docBinding;
      const _realTime = realTime;
      const _useBroadcastChannel = this._useBroadcastChannel;

      this._localPromise = (async () => {
        const identity = await local.getIdentity();
        const provider = new local.provider(identity) as ClientProvider<S, O>;
        // Initialize ServerSync now that we have the provider
        if (server) {
          this._serverSync = new ServerSync({
            provider,
            url: server.url,
            docBinding: _docBinding,
            getToken: server.auth.getToken,
            realTime: _realTime,
            onServerOperations: ({ docId, operations }) => {
              void this._applyServerOperations({ docId, operations });
            },
          });
        }

        // Initialize BroadcastChannel with user-specific channel name
        // This ensures only tabs of the same user share operations
        if (_useBroadcastChannel) {
          this._broadcastChannel = new BroadcastChannel(
            `docsync:${identity.userId}`,
          );
          this._broadcastChannel.onmessage = async (
            ev: MessageEvent<BroadcastMessage<O>>,
          ) => {
            // RECEIVED MESSAGES
            if (ev.data.type === "OPERATIONS") {
              void this._applyOperations(ev.data.operations, ev.data.docId);
              return;
            }
            /* v8 ignore next -- @preserve */
            ev.data.type satisfies never;
          };
        }

        return { provider, identity };
      })();
    }
  }

  async _applyOperations(operations: O, docId: string) {
    const docFromCache = this._docsCache.get(docId);
    if (!docFromCache) return;
    const doc = await docFromCache.promisedDoc;
    if (!doc) return;
    this._shouldBroadcast = false;
    this._docBinding.applyOperations(doc, operations);
    this._shouldBroadcast = true;
  }

  // TODO: used when server responds with a new doc (squashing)
  async _replaceDocInCache({
    docId,
    doc,
    serializedDoc,
  }: {
    docId: string;
    doc?: D;
    serializedDoc?: S;
  }) {
    const cacheEntry = this._docsCache.get(docId);
    if (!cacheEntry) return;

    // Deserialize if needed
    const newDoc = doc ?? this._docBinding.deserialize(serializedDoc!);

    // Replace the cached document with the new one
    // Keep the same refCount
    // Note: We don't setup a new change listener here because:
    // 1. The doc already has all operations applied from the sync
    // 2. A listener will be setup when the doc is loaded via getDoc
    // 3. Multiple listeners would cause operations to be applied multiple times
    this._docsCache.set(docId, {
      promisedDoc: Promise.resolve(newDoc),
      refCount: cacheEntry.refCount,
    });
  }

  async _applyServerOperations({
    docId,
    operations,
  }: {
    docId: string;
    operations: O[];
  }) {
    const cacheEntry = this._docsCache.get(docId);
    if (!cacheEntry) return;

    // Get the cached document and apply server operations to it
    const doc = await cacheEntry.promisedDoc;
    if (!doc) return;

    this._shouldBroadcast = false;
    for (const op of operations) {
      this._docBinding.applyOperations(doc, op);
    }
    this._shouldBroadcast = true;
  }

  /**
   * Subscribe to a document with reactive state updates.
   *
   * The behavior depends on which fields are provided:
   * - `{ type, id }` → Try to get an existing doc. Returns `undefined` if not found.
   * - `{ type, createIfMissing: true }` → Create a new doc with auto-generated ID (ulid).
   * - `{ type, id, createIfMissing: true }` → Get existing doc or create it if not found.
   *
   * The callback will be invoked with state updates:
   * 1. `{ status: "loading" }` - Initial state while fetching
   * 2. `{ status: "success", data: { doc, id } }` - Document loaded successfully
   * 3. `{ status: "error", error }` - Failed to load document
   *
   * To observe document content changes, use `doc.onChange()` directly on the returned doc.
   *
   * @example
   * ```ts
   * const unsubscribe = client.getDoc(
   *   { type: "notes", id: "abc123" },
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
    const type = args.type;
    const argId = "id" in args ? args.id : undefined;
    const createIfMissing = "createIfMissing" in args && args.createIfMissing;
    // Internal emit uses wider type; runtime logic ensures correct data per overload
    const emit = callback as (
      result: QueryResult<DocData<D> | undefined>,
    ) => void;
    let docId: string | undefined;

    // Case: { type, createIfMissing: true } → Create new doc with auto-generated ID (sync).
    if (!argId && createIfMissing) {
      const { doc, id } = this._docBinding.new(type);
      docId = id;
      this._docsCache.set(id, {
        promisedDoc: Promise.resolve(doc),
        refCount: 1,
      });
      this._setupChangeListener(doc, id);
      // Subscribe to real-time updates
      void this._serverSync?.subscribeDoc(id);
      emit({ status: "success", data: { doc, id }, error: undefined });
      void (async () => {
        const local = await this._localPromise;
        if (!local) return;
        await local.provider.transaction("readwrite", (ctx) =>
          ctx.saveSerializedDoc({
            serializedDoc: this._docBinding.serialize(doc),
            docId: id,
            clock: 0,
          }),
        );
      })();
      // TODO: review this
      // This forces a fetch if the document exists on the server.
      void this.onLocalOperations({
        docId: id,
        operations: [] as O[],
      });
      return () => void this._unloadDoc(id);
    }

    // Preparing for the async cases
    emit({ status: "loading", data: undefined, error: undefined });

    // Case: { type, id } or { type, id, createIfMissing } → Load or create (async).
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
              createIfMissing ? type : undefined,
            );
            this._docsCache.set(docId, { promisedDoc, refCount: 1 });
            doc = await promisedDoc;
            if (doc) {
              // Register listener only for new docs (not cache hits)
              this._setupChangeListener(doc, docId);
              // Subscribe to real-time updates when first document reference is created
              void this._serverSync?.subscribeDoc(docId);
            }
          }
          emit({
            status: "success",
            data: doc ? { doc, id: docId } : undefined,
            error: undefined,
          });
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          emit({ status: "error", data: undefined, error });
        }
      })();
      // This forces a fetch if the document exists on the server.
      void this.onLocalOperations({
        docId,
        operations: [] as O[],
      });
    }

    return () => {
      if (docId) void this._unloadDoc(docId);
    };
  }

  private _setupChangeListener(doc: D, docId: string) {
    this._docBinding.onChange(doc, ({ operations }) => {
      if (this._shouldBroadcast) {
        this._sendMessage({ type: "OPERATIONS", operations, docId });
        void this.onLocalOperations({ docId, operations: [operations] });
      }
      // Don't automatically reset _shouldBroadcast here!
      // Let the caller explicitly control when to re-enable broadcasting
    });
  }

  private async _loadOrCreateDoc(
    docId: string,
    type?: string,
  ): Promise<D | undefined> {
    const local = await this._localPromise;
    if (!local) return undefined;

    return local.provider.transaction("readwrite", async (ctx) => {
      // Try to load existing doc
      const stored = await ctx.getSerializedDoc(docId);
      const localOperations = await ctx.getOperations({ docId });

      if (stored) {
        const doc = this._docBinding.deserialize(stored.serializedDoc);
        this._shouldBroadcast = false;
        localOperations.forEach((operationsBatch) => {
          operationsBatch.forEach((operations) => {
            this._docBinding.applyOperations(doc, operations);
          });
        });
        this._shouldBroadcast = true;
        return doc;
      }

      // Create new doc if type provided
      if (type) {
        const { doc } = this._docBinding.new(type, docId);
        this._shouldBroadcast = false;
        if (localOperations.length)
          throw new Error(
            `Doc ${docId} has operations stored locally but no serialized doc found`,
          );
        this._shouldBroadcast = true;
        // Save the new doc to IDB
        await ctx.saveSerializedDoc({
          serializedDoc: this._docBinding.serialize(doc),
          docId,
          clock: 0,
        });
        return doc;
      }

      return undefined;
    });
  }

  /**
   * Decrease the reference count of a document and, if it is 0, delete the document from the cache.
   */
  protected async _unloadDoc(docId: string) {
    const cacheEntry = this._docsCache.get(docId);
    if (!cacheEntry) return;
    if (cacheEntry.refCount > 1) {
      cacheEntry.refCount -= 1;
    } else {
      // Unsubscribe from real-time updates when last reference is removed
      await this._serverSync?.unsubscribeDoc(docId);
      this._docsCache.delete(docId);
      const doc = await cacheEntry.promisedDoc;
      if (!doc) return;
      this._docBinding.removeListeners(doc);
    }
  }

  _sendMessage(message: BroadcastMessage<O>) {
    if (this._broadcastChannel) {
      this._broadcastChannel.postMessage(message);
    }
  }

  async onLocalOperations({
    docId,
    operations,
  }: {
    docId: string;
    operations: O[];
  }) {
    // 1. Save locally
    const local = await this._localPromise;
    await local?.provider.transaction("readwrite", (ctx) =>
      ctx.saveOperations({ docId, operations }),
    );
    // 2. Save remotely
    this._serverSync?.saveRemote({ docId });
  }
}
