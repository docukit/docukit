/* eslint-disable @typescript-eslint/no-empty-object-type */

import type { DocSyncClient } from "../index.js";

type BroadcastMessage<O> =
  | {
      type: "OPERATIONS";
      operations: O;
      docId: string;
      presence?: Record<string, unknown>;
    }
  | { type: "PRESENCE"; docId: string; presence: Record<string, unknown> };

export class BCHelper<D extends {}, S extends {}, O extends {} = {}> {
  private _channel: BroadcastChannel;

  constructor(client: DocSyncClient<D, S, O>) {
    const channelName = `docsync:${client["_clientId"]}`;
    this._channel = new BroadcastChannel(channelName);
    this._channel.onmessage = (ev: MessageEvent<BroadcastMessage<O>>) => {
      const msg = ev.data;
      if (msg.type === "OPERATIONS") {
        const { docId, operations, presence } = msg;
        const currentStatus = client["_pushStatusByDocId"].get(docId) ?? "idle";
        if (currentStatus === "pushing") {
          client["_pushStatusByDocId"].set(docId, "pushing-with-pending");
        }
        void this._applyOperations(client, operations, docId);
        if (presence) {
          const cacheEntry = client["_docsCache"].get(docId);
          if (cacheEntry) client["_applyPresencePatch"](cacheEntry, presence);
        }
        return;
      }
      if (msg.type === "PRESENCE") {
        const { docId, presence } = msg;
        const cacheEntry = client["_docsCache"].get(docId);
        if (!cacheEntry) return;
        client["_applyPresencePatch"](cacheEntry, presence);
      }
    };
  }

  private async _applyOperations(
    client: DocSyncClient<D, S, O>,
    operations: O,
    docId: string,
  ): Promise<void> {
    const cacheEntry = client["_docsCache"].get(docId);
    if (!cacheEntry) return;
    const doc = await cacheEntry.promisedDoc;
    if (!doc) return;
    client["_shouldBroadcast"] = false;
    client["_docBinding"].applyOperations(doc, operations);
    client["_shouldBroadcast"] = true;
    client["_emit"](client["_changeEventListeners"], {
      docId,
      origin: "broadcast",
      operations: [operations],
    });
  }

  broadcast(message: BroadcastMessage<O>): void {
    this._channel.postMessage(message);
  }

  /** Close the underlying channel (e.g. for test cleanup). */
  close(): void {
    this._channel.close();
  }
}
