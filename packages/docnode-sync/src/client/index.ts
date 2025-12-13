import { IndexedDBProvider } from "./providers/indexeddb.js";
import { Doc, type Operations } from "docnode";
import { type DocConfig, type JsonDoc } from "docnode";

export type WorkerConfig = {
  url: string;
  userId: string;
};

export type MessageToWorker =
  | {
      type: "INIT";
      workerConfig: WorkerConfig;
    }
  | {
      type: "OPERATIONS";
      operations: Operations;
      docId: string;
    };

export type MessageFromWorker =
  | {
      type: "ERROR";
      error: string;
    }
  | {
      type: "OPERATIONS";
      operations: Operations;
      docId: string;
    };

export type ClientConfig = WorkerConfig & {
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
  private _sharedWorker: SharedWorker;
  private _shouldBroadcast = true;

  constructor(config: ClientConfig) {
    if (typeof window === "undefined")
      throw new Error("DocNodeClient can only be used in the browser");
    this._sharedWorker = new SharedWorker("docnode-worker.js", {
      name: "DocNode Shared Worker",
    });
    const { docConfigs, ...workerConfig } = config;
    docConfigs.forEach((docConfig) => {
      const namespace = docConfig.namespace ?? "";
      if (this._docConfigs.has(namespace)) {
        throw new Error(`Duplicate namespace: ${namespace}`);
      }
      this._docConfigs.set(namespace, docConfig);
    });
    const port = this._sharedWorker.port;
    port.start();
    port.onmessage = async (ev: MessageEvent<MessageFromWorker>) => {
      if (ev.data.type === "ERROR") {
        throw new Error("Error in docnode-worker: " + ev.data.error);
      }
      if (ev.data.type === "OPERATIONS") {
        const { operations, docId } = ev.data;
        const docFromCache = this._docsCache.get(docId);
        if (!docFromCache) return;
        const doc = await docFromCache.promisedDoc;
        this._shouldBroadcast = false;
        doc.applyOperations(operations);
        return;
      }
      ev.data satisfies never;
    };
    this.sendMessage({ type: "INIT", workerConfig });
  }

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
        this.sendMessage({ type: "OPERATIONS", operations, docId });
      }
      this._shouldBroadcast = true;
      // Possible micro-optimization for the future:
      // instead of pushing in the worker, it could be done here. This is because
      // sending something to a worker takes as long as saving it in IndexedDB!
      // See https://x.com/GermanJablo/status/1898569709131313255
      // However, for small payloads, this might be negligible.
      // In the worker I already have WebSockets, and here I would need to create an HTTP endpoint.
      // I also would need to identify the request with an ID (because the response
      // would be handled by the worker), so that would add some complexity.
    });
    return doc;
  }

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

  sendMessage(message: MessageToWorker) {
    this._sharedWorker.port.postMessage(message);
  }
}
