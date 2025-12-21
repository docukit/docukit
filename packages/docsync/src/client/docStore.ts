import type { DocBinding, SerializedDoc } from "../shared/docBinding.js";
import type { ClientProvider } from "./index.js";

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

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export class DocStore<D extends {}, S extends SerializedDoc, O extends {}> {
  // prettier-ignore
  private _docsCache = new Map<string, { promisedDoc: Promise<D | undefined>; refCount: number; }>();
  private _docBinding: DocBinding<D, S, O>;
  private _localProvider: ClientProvider<S, O> | undefined;
  private _onChangeDoc: (doc: D, docId: string) => void;

  constructor(options: {
    docBinding: DocBinding<D, S, O>;
    localProvider: ClientProvider<S, O> | undefined;
    onChangeDoc: (doc: D, docId: string) => void;
  }) {
    this._docBinding = options.docBinding;
    this._localProvider = options.localProvider;
    this._onChangeDoc = options.onChangeDoc;
  }

  async getDocFromCache(docId: string): Promise<D | undefined> {
    const cacheEntry = this._docsCache.get(docId);
    if (!cacheEntry) return undefined;
    return cacheEntry.promisedDoc;
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
      await this._localProvider?.saveSerializedDoc({
        serializedDoc,
        docId: id,
      });
      this._onChangeDoc(doc, id);
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
      this._onChangeDoc(doc, id);
      return { doc, id };
    } else {
      return undefined;
    }
  }

  /**
   * Decrease the reference count of a document and, if it is 0, delete the document from the cache.
   */
  async unloadDoc(docId: string) {
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

  private async _loadOrCreateDoc(
    id: string,
    namespace?: string,
  ): Promise<D | undefined> {
    // Try to load existing doc
    const serializedDoc = (await this._localProvider?.getSerializedDoc(id))
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
}
