import { IndexedDBProvider } from "./providers/indexeddb.js";
import { Doc, type Operations } from "docnode";
import { type DocConfig, type JsonDoc } from "docnode";

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
  getOperations(): Promise<Operations>;
  mergeAndDeleteOperations(operations: Operations): Promise<void>;
  deleteOperations(count: number): Promise<void>;
  saveOperations(operations: Operations): Promise<void>;
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

    // Listen for operations from other tabs.
    this._broadcastChannel = new BroadcastChannel("docnode-sync");
    this._broadcastChannel.onmessage = async (
      ev: MessageEvent<BroadcastMessage>,
    ) => {
      if (ev.data.type === "OPERATIONS") {
        const { operations, docId } = ev.data;
        const docFromCache = this._docsCache.get(docId);
        if (!docFromCache) return;
        const doc = await docFromCache.promisedDoc;
        this._shouldBroadcast = false;
        doc.applyOperations(operations);
        return;
      }
      ev.data.type satisfies never;
    };
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
    // @ts-expect-error - read-only property
    doc.id = docId;

    doc.onChange(({ operations }) => {
      if (this._shouldBroadcast) {
        this._sendMessage({ type: "OPERATIONS", operations, docId });
        this._provider.saveOperations(operations);
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
}
