import type { DocBinding, SerializedDoc } from "../shared/docBinding.js";
import type { ClientProvider } from "./types.js";
import { API, type APIOptions } from "./utils.js";

/* eslint-disable @typescript-eslint/no-empty-object-type */
export type ServerSyncConfig<
  D extends {},
  S extends SerializedDoc,
  O extends {},
> = {
  provider: ClientProvider<S, O>;
  url: string;
  docBinding: DocBinding<D, S, O>;
  getToken: () => Promise<string>;
  realTime: boolean;
  onServerOperations?: (payload: { docId: string; operations: O[] }) => void;
};

type PushStatus = "idle" | "pushing" | "pushing-with-pending";

export class ServerSync<D extends {}, S extends SerializedDoc, O extends {}> {
  private _provider: ClientProvider<S, O>;
  protected _api: API<S, O>;
  private _docBinding: DocBinding<D, S, O>;
  // Per-docId push status to allow concurrent pushes for different docs
  protected _pushStatusByDocId = new Map<string, PushStatus>();
  protected _subscribedDocs = new Set<string>();
  private _realTime: boolean;
  private _onServerOperations?:
    | ((payload: { docId: string; operations: O[] }) => void)
    | undefined;

  constructor(config: ServerSyncConfig<D, S, O>) {
    this._provider = config.provider;
    this._realTime = config.realTime;
    this._onServerOperations = config.onServerOperations;
    const { url, getToken } = config;

    // Build API options conditionally based on realTime flag
    const apiOptions: APIOptions = { url, getToken };
    if (this._realTime) {
      apiOptions.onDirty = (payload) => {
        // When server notifies us of changes, trigger a sync (reuse saveRemote)
        this.saveRemote({ docId: payload.docId });
      };
      apiOptions.onReconnect = () => {
        // Re-subscribe to all documents after reconnection
        void this._resubscribeAll();
      };
    }

    this._api = new API(apiOptions);
    this._docBinding = config.docBinding;
  }

  /**
   * Re-subscribe to all documents after reconnection.
   */
  private async _resubscribeAll(): Promise<void> {
    const docIds = Array.from(this._subscribedDocs);
    console.log(`Reconnected - resubscribing to ${docIds.length} documents`);
    for (const docId of docIds) {
      try {
        await this._api.request("subscribe-doc", { docId });
      } catch (err) {
        console.error(`Failed to resubscribe to ${docId}:`, err);
      }
    }
  }

  /**
   * Subscribe to real-time updates for a document.
   * Should be called when a document is first loaded (refCount 0 → 1).
   */
  async subscribeDoc(docId: string): Promise<void> {
    if (!this._realTime) return;
    if (this._subscribedDocs.has(docId)) return;
    await this._api.request("subscribe-doc", { docId });
    this._subscribedDocs.add(docId);
  }

  /**
   * Unsubscribe from real-time updates for a document.
   * Should be called when a document is unloaded (refCount 1 → 0).
   */
  async unsubscribeDoc(docId: string): Promise<void> {
    if (!this._realTime) return;
    if (!this._subscribedDocs.has(docId)) return;
    await this._api.request("unsubscribe-doc", { docId });
    this._subscribedDocs.delete(docId);
  }

  /**
   * Push local operations to the server for a specific document.
   * Uses a per-docId queue to prevent concurrent pushes for the same doc.
   */
  saveRemote({ docId }: { docId: string }) {
    const status = this._pushStatusByDocId.get(docId) ?? "idle";
    if (status !== "idle") {
      this._pushStatusByDocId.set(docId, "pushing-with-pending");
      return;
    }
    void this._doPush({ docId });
  }

  protected async _doPush({ docId }: { docId: string }) {
    this._pushStatusByDocId.set(docId, "pushing");

    const operationsBatches = await this._provider.transaction(
      "readonly",
      (ctx) => ctx.getOperations({ docId }),
    );
    const operations = operationsBatches.flat();

    let response;
    try {
      response = await this._api.request("sync-operations", {
        clock: 0,
        docId,
        operations,
      });
    } catch {
      // Retry on failure
      this._pushStatusByDocId.set(docId, "idle");
      void this._doPush({ docId });
      return;
    }

    // Atomically: delete synced operations + consolidate into serialized doc
    await this._provider.transaction("readwrite", async (ctx) => {
      // Delete client operations that were synced (delete batches, not individual ops)
      if (operationsBatches.length > 0) {
        await ctx.deleteOperations({
          docId,
          count: operationsBatches.length,
        });
      }

      // Consolidate operations into serialized doc
      const stored = await ctx.getSerializedDoc(docId);
      if (!stored) return;

      const doc = this._docBinding.deserialize(stored.serializedDoc);

      // Apply server operations first (following server's authoritative order)
      if (response.operations) {
        for (const op of response.operations) {
          this._docBinding.applyOperations(doc, op);
        }
      }

      // Then apply client operations
      for (const op of operations) {
        this._docBinding.applyOperations(doc, op);
      }
      const serializedDoc = this._docBinding.serialize(doc);

      await ctx.saveSerializedDoc({
        serializedDoc,
        docId,
        clock: stored.clock + 1, // TODO: proper clock from server
      });
    });

    // Notify that the doc has been updated with server operations
    // This will apply the operations to the in-memory cached document
    if (this._onServerOperations && response.operations) {
      this._onServerOperations({ docId, operations: response.operations });
    }

    // Status may have changed to "pushing-with-pending" during async ops
    const currentStatus = this._pushStatusByDocId.get(docId);
    const shouldRetry = currentStatus === "pushing-with-pending";
    this._pushStatusByDocId.set(docId, "idle");
    if (shouldRetry) void this._doPush({ docId });
  }
}
