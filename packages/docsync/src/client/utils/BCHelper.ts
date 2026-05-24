/* eslint-disable @typescript-eslint/no-empty-object-type */

import type { DocSyncClient } from "../index.js";
import { applyPresencePatch } from "./applyPresencePatch.js";

type BroadcastMessage<O> =
  | {
      type: "OPERATIONS";
      source: "local" | "remote";
      operations: O;
      docId: string;
      flags?: { skipUndo?: boolean };
      presence?: Record<string, unknown>;
    }
  | { type: "PRESENCE"; docId: string; presence: Record<string, unknown> };

export class BCHelper<D extends {}, S extends {}, O extends {} = {}> {
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
    source: "local" | "remote",
    flags?: { skipUndo?: boolean },
  ): Promise<void> {
    const cacheEntry = client["_docsCache"].get(docId);
    if (!cacheEntry) return;
    const doc = await cacheEntry.promisedDoc;
    if (!doc) return;
    client["_docBinding"].applyOperations(
      doc,
      operations,
      source === "remote"
        ? { ...flags, origin: "network", skipUndo: true }
        : { ...flags, origin: "local-broadcast" },
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
