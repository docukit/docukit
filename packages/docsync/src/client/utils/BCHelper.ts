import type { DocSyncClient } from "../index.js";
import { applyPresencePatch } from "./applyPresencePatch.js";

type BroadcastSource = "network" | "local-broadcast";

type BroadcastMessage<O> =
  | {
      type: "OPERATIONS";
      source: BroadcastSource;
      operations: O;
      docId: string;
      flags?: { skipUndo?: boolean };
      presence?: Record<string, unknown>;
    }
  | { type: "PRESENCE"; docId: string; presence: Record<string, unknown> };

export class BCHelper<
  D extends object,
  S extends object,
  O extends object = object,
> {
  private _channel: BroadcastChannel;
  private _closed = false;

  constructor(client: DocSyncClient<D, S, O>, userId: string) {
    const channelName = `docsync:${userId}`;
    this._channel = new BroadcastChannel(channelName);
    this._channel.onmessage = (ev: MessageEvent<BroadcastMessage<O>>) => {
      const msg = ev.data;
      if (msg.type === "OPERATIONS") {
        const { docId, flags, operations, presence, source } = msg;
        const currentStatus = client["_pushStatusByDocId"].get(docId) ?? "idle";
        if (currentStatus === "pushing") {
          client["_pushStatusByDocId"].set(docId, "pushing-with-pending");
        }
        void this._applyOperations(client, operations, docId, source, flags);
        if (presence) {
          const cacheEntry = client["_docsCache"].get(docId);
          if (cacheEntry)
            applyPresencePatch(client["_clientId"], cacheEntry, presence);
        }
        return;
      }
      if (msg.type === "PRESENCE") {
        const { docId, presence } = msg;
        const cacheEntry = client["_docsCache"].get(docId);
        if (!cacheEntry) return;
        applyPresencePatch(client["_clientId"], cacheEntry, presence);
      }
    };
  }

  private async _applyOperations(
    client: DocSyncClient<D, S, O>,
    operations: O,
    docId: string,
    source: BroadcastSource,
    flags?: { skipUndo?: boolean },
  ): Promise<void> {
    const cacheEntry = client["_docsCache"].get(docId);
    if (!cacheEntry) return;
    const doc = await cacheEntry.promisedDoc;
    if (!doc) return;
    client["_applyOperationsFrom"](
      source,
      doc,
      operations,
      source === "network" ? { ...flags, skipUndo: true } : flags,
    );
  }

  broadcast(message: BroadcastMessage<O>): void {
    if (this._closed) return;
    this._channel.postMessage(message);
  }

  /** Close the underlying channel (e.g. for test cleanup). */
  close(): void {
    this._closed = true;
    this._channel.close();
  }
}
