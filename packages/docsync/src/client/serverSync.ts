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

export class ServerSync<D extends {}, S extends SerializedDoc, O extends {}> {
  private _provider: ClientProvider<S, O>;
  private _api: API<S, O>;
  private _docBinding: DocBinding<D, S, O>;
  private _pushStatus: "idle" | "pushing" | "pushing-with-pending" = "idle";

  constructor(config: ServerSyncConfig<D, S, O>) {
    this._provider = config.provider;
    this._api = new API({ url: config.url });
    this._docBinding = config.docBinding;
  }

  /**
   * Called when operations are saved to local storage.
   * Triggers sync with the server.
   * This is the only public method or property of the class.
   */
  onSaved({ docId }: { docId: string }) {
    if (this._pushStatus !== "idle") {
      this._pushStatus = "pushing-with-pending";
      return;
    }
    void this._push({ docId });
  }

  private async _push({ docId }: { docId: string }) {
    if (this._pushStatus !== "idle")
      throw new Error("Push already in progress");
    this._pushStatus = "pushing";

    // Get operations to sync (separate transaction - we need them for API call)
    const allOperations = await this._provider.transaction("readonly", (ctx) =>
      ctx.getOperations({ docId }),
    );

    try {
      await this._api.request("sync-operations", [
        // TODO: convert allOperations to proper format
        { clock: 0, docId: "", operations: [] },
      ]);
    } catch {
      // Retry on failure
      this._pushStatus = "idle";
      void this._push({ docId });
      return;
    }

    // Atomically: delete synced operations + consolidate into serialized doc
    await this._provider.transaction("readwrite", async (ctx) => {
      await ctx.deleteOperations({
        docId,
        count: allOperations.length,
      });

      // Consolidate operations into serialized doc
      const stored = await ctx.getSerializedDoc(docId);
      if (!stored) return;

      const doc = this._docBinding.deserialize(stored.serializedDoc);
      for (const op of allOperations) {
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
    // @ts-expect-error TS doesn't track async mutations to _pushStatus
    const shouldRetry = this._pushStatus === "pushing-with-pending";
    this._pushStatus = "idle";
    if (shouldRetry) void this._push({ docId });
  }
}
