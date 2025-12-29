import type { DocBinding, SerializedDoc } from "../shared/docBinding.js";
import type { ClientProvider } from "./types.js";
import { API } from "./utils.js";

/* eslint-disable @typescript-eslint/no-empty-object-type */
export type ServerSyncConfig<
  D extends {},
  S extends SerializedDoc,
  O extends {},
> = {
  provider: ClientProvider<S, O>;
  url: string;
  docBinding: DocBinding<D, S, O>;
};

type PushStatus = "idle" | "pushing" | "pushing-with-pending";

export class ServerSync<D extends {}, S extends SerializedDoc, O extends {}> {
  private _provider: ClientProvider<S, O>;
  private _api: API<S, O>;
  private _docBinding: DocBinding<D, S, O>;
  // Per-docId push status to allow concurrent pushes for different docs
  protected _pushStatusByDocId = new Map<string, PushStatus>();

  constructor(config: ServerSyncConfig<D, S, O>) {
    this._provider = config.provider;
    const { url } = config;
    this._api = new API({ url });
    this._docBinding = config.docBinding;
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

    const operations = await this._provider.transaction("readonly", (ctx) =>
      ctx.getOperations({ docId }),
    );

    // Nothing to push - but check if more were queued during fetch
    if (operations.length === 0) {
      const currentStatus = this._pushStatusByDocId.get(docId);
      const shouldRetry = currentStatus === "pushing-with-pending";
      this._pushStatusByDocId.set(docId, "idle");
      if (shouldRetry) void this._doPush({ docId });
      return;
    }

    try {
      await this._api.request("sync-operations", {
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
      await ctx.deleteOperations({
        docId,
        count: operations.length,
      });

      // Consolidate operations into serialized doc
      const stored = await ctx.getSerializedDoc(docId);
      if (!stored) return;

      const doc = this._docBinding.deserialize(stored.serializedDoc);
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

    // Status may have changed to "pushing-with-pending" during async ops
    const currentStatus = this._pushStatusByDocId.get(docId);
    const shouldRetry = currentStatus === "pushing-with-pending";
    this._pushStatusByDocId.set(docId, "idle");
    if (shouldRetry) void this._doPush({ docId });
  }
}
