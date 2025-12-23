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
  onSaved() {
    if (this._pushStatus !== "idle") {
      this._pushStatus = "pushing-with-pending";
      return;
    }
    void this._push();
  }

  private async _push() {
    if (this._pushStatus !== "idle")
      throw new Error("Push already in progress");
    this._pushStatus = "pushing";

    const allOperations = await this._provider.getOperations();

    try {
      await this._api.request("sync-operations", [
        // TODO: convert allOperations to proper format
        { clock: 0, docId: "", operations: [] },
      ]);
    } catch {
      // Retry on failure
      this._pushStatus = "idle";
      void this._push();
      return;
    }

    await this._provider.deleteOperations(allOperations.length);

    // Consolidate operations into serialized docs
    await this._consolidateOps(allOperations);

    // Status may have changed to "pushing-with-pending" during async ops
    // @ts-expect-error TS doesn't track async mutations to _pushStatus
    const shouldRetry = this._pushStatus === "pushing-with-pending";
    this._pushStatus = "idle";
    if (shouldRetry) void this._push();
  }

  /**
   * After successful push, consolidate pending operations into the serialized doc.
   * Groups operations by docId and applies them to each doc.
   */
  private async _consolidateOps(
    allOperations: { docId: string; operations: O }[],
  ) {
    // Group operations by docId
    const opsByDoc = new Map<string, O[]>();
    for (const { docId, operations } of allOperations) {
      const ops = opsByDoc.get(docId) ?? [];
      ops.push(operations);
      opsByDoc.set(docId, ops);
    }

    // For each doc: load → deserialize → apply ops → serialize → save
    for (const [docId, ops] of opsByDoc) {
      const stored = await this._provider.getSerializedDoc(docId);
      if (!stored) continue;

      const doc = this._docBinding.deserialize(stored.serializedDoc);
      for (const operations of ops) {
        this._docBinding.applyOperations(doc, operations);
      }
      const serializedDoc = this._docBinding.serialize(doc);

      await this._provider.saveSerializedDoc({
        serializedDoc,
        docId,
        clock: stored.clock + 1, // TODO: proper clock from server
      });
    }
  }
}
