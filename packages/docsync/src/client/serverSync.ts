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
      url: config.server.url,
      getToken: config.server.auth.getToken,
      onDirty: (payload) => {
        // When server notifies us of changes, trigger a sync (reuse saveRemote)
        this.saveRemote({ docId: payload.docId });
      },
      onReconnect: () => {
        // Notify parent to re-sync all active documents
        this._onReconnect?.();
      },
      onDisconnect: () => {
        // Reset all push statuses when socket disconnects
        // This ensures that any in-flight requests don't leave the status stuck
        this._pushStatusByDocId.clear();
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
    // Skip if socket is not connected (e.g., in local-only mode or during tests)
    if (!this._api["_socket"]?.connected) return;
    try {
      await this._api.request("unsubscribe-doc", { docId });
    } catch {
      // Silently ignore errors during cleanup (e.g., socket
      // disconnected during request, timeout, or server error)
    }
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

      // Skip consolidation if another client (same IDB) already updated to this clock
      // This handles the case where another tab/client already wrote this update
      if (stored.clock >= response.clock) {
        return;
      }

      // Collect all operations to apply: server ops first, then client ops
      const serverOps = response.operations ?? [];
      const allOps = [...serverOps, ...operations];

      // Only proceed if there are operations to apply
      if (allOps.length > 0) {
        const doc = this._docBinding.deserialize(stored.serializedDoc);

        // Apply all operations in order (server ops first, then client ops)
        for (const op of allOps) {
          this._docBinding.applyOperations(doc, op);
        }
        const serializedDoc = this._docBinding.serialize(doc);

        // Before saving, verify clock hasn't changed (another concurrent write)
        // This prevents race conditions when multiple tabs/clients share the same IDB
        const recheckStored = await ctx.getSerializedDoc(docId);
        if (!recheckStored || recheckStored.clock !== stored.clock) {
          // Clock changed during our transaction - another client beat us
          // Silently skip to avoid duplicate operations
          return;
        }

        await ctx.saveSerializedDoc({
          serializedDoc,
          docId,
          clock: response.clock, // Use clock from server
        });
      }
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
    if (shouldRetry) {
      // Keep status as "pushing" and retry immediately to avoid race window
      // where a dirty event could trigger another concurrent _doPush
      void this._doPush({ docId });
    } else {
      this._pushStatusByDocId.set(docId, "idle");
    }
  }
}
