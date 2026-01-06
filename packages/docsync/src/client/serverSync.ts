import type { DocBinding, SerializedDoc } from "../shared/docBinding.js";
import type { ClientConfig } from "./types.js";
import { API, type APIOptions } from "./utils.js";
import type { LocalResolved } from "./index.js";

/* eslint-disable @typescript-eslint/no-empty-object-type */
export type ServerSyncConfig<
  D extends {},
  S extends SerializedDoc,
  O extends {},
> = Exclude<ClientConfig<D, S, O>, "provider"> & {
  localPromise: Promise<LocalResolved<S, O>>;
  onServerOperations?: (payload: { docId: string; operations: O[] }) => void;
};

type PushStatus = "idle" | "pushing" | "pushing-with-pending";

export class ServerSync<D extends {}, S extends SerializedDoc, O extends {}> {
  private _localPromise: Promise<LocalResolved<S, O>>;
  protected _api: API<S, O>;
  private _docBinding: DocBinding<D, S, O>;
  // Per-docId push status to allow concurrent pushes for different docs
  protected _pushStatusByDocId = new Map<string, PushStatus>();
  private _onServerOperations?:
    | ((payload: { docId: string; operations: O[] }) => void)
    | undefined;
  private _onReconnect?: () => void;

  constructor(config: ServerSyncConfig<D, S, O>) {
    this._localPromise = config.localPromise;
    this._onServerOperations = config.onServerOperations;

    // Build API options conditionally based on realTime flag
    const apiOptions: APIOptions = {
      url: config.server!.url,
      getToken: config.server!.auth.getToken,
      onDirty: (payload) => {
        // When server notifies us of changes, trigger a sync (reuse saveRemote)
        this.saveRemote({ docId: payload.docId });
      },
      onReconnect: () => {
        // Notify parent to re-sync all active documents
        this._onReconnect?.();
      },
    };

    this._api = new API(apiOptions);
    this._docBinding = config.docBinding;
  }

  /**
   * Set callback to be invoked when the socket reconnects.
   * The parent (DocSyncClient) should use this to re-sync all active documents.
   */
  setReconnectHandler(handler: () => void): void {
    this._onReconnect = handler;
  }

  /**
   * Unsubscribe from real-time updates for a document.
   * Should be called when a document is unloaded (refCount 1 → 0).
   */
  async unsubscribeDoc(docId: string): Promise<void> {
    await this._api.request("unsubscribe-doc", { docId });
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
    const provider = (await this._localPromise).provider;

    // Get the current clock value and operations from provider
    const [operationsBatches, stored] = await provider.transaction(
      "readonly",
      async (ctx) => {
        return Promise.all([
          ctx.getOperations({ docId }),
          ctx.getSerializedDoc(docId),
        ]);
      },
    );
    const operations = operationsBatches.flat();
    const clientClock = stored?.clock ?? 0;

    let response;
    try {
      response = await this._api.request("sync-operations", {
        clock: clientClock,
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
    await provider.transaction("readwrite", async (ctx) => {
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
        clock: response.clock, // Use clock from server
      });
    });

    // Notify that the doc has been updated with server operations
    // This will apply ONLY the server operations to the in-memory cached document
    if (response?.operations && response.operations.length > 0) {
      this._onServerOperations?.({
        docId,
        operations: response.operations,
      });
    }

    // Status may have changed to "pushing-with-pending" during async ops
    const currentStatus = this._pushStatusByDocId.get(docId);
    const shouldRetry = currentStatus === "pushing-with-pending";
    this._pushStatusByDocId.set(docId, "idle");
    if (shouldRetry) void this._doPush({ docId });
  }
}
