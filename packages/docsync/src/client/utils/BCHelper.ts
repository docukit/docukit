import type { DocSyncClient } from "../index.js";
import { followStoredDoc } from "../handlers/clientInitiated/sync/sync.js";
import { applyPresencePatch } from "./applyPresencePatch.js";

type BroadcastMessage<O> =
  | {
      /** An edit made in another tab. */
      type: "OPERATIONS";
      operations: O;
      docId: string;
      flags: { skipUndo?: boolean };
      presence: Record<string, unknown>;
    }
  | {
      /** Another tab stored the doc: see `followStoredDoc`. */
      type: "STORED";
      docId: string;
      fromClock: number | undefined;
      clock: number;
      operations: O[];
      sent: O[];
      presence: Record<string, unknown>;
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
      const { docId, presence } = msg;
      if (msg.type === "OPERATIONS") {
        // Operations from another tab landed while a sync was in flight; that
        // sync goes again when it finishes so the server sees them too.
        const runningSync = client["_syncQueue"].get(docId);
        if (runningSync) runningSync.rerun = true;
        void this._applyOperations(client, msg.operations, docId, msg.flags);
      }
      if (msg.type === "STORED") void followStoredDoc(client, msg);
      const cacheEntry = client["_docsCache"].get(docId);
      if (cacheEntry)
        applyPresencePatch(client["_clientId"], cacheEntry, presence);
    };
  }

  private async _applyOperations(
    client: DocSyncClient<D, S, O>,
    operations: O,
    docId: string,
    flags: { skipUndo?: boolean },
  ): Promise<void> {
    const cacheEntry = client["_docsCache"].get(docId);
    if (!cacheEntry) return;
    const doc = await cacheEntry.promisedDoc;
    if (!doc) return;
    client["_applyOperationsFrom"](
      "local-broadcast",
      doc,
      operations,
      // Incoming changes belong to another tab, even for the same user.
      { ...flags, skipUndo: true },
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
