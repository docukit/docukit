import { isExistingGetDocData } from "../../shared/validators/getDocData.js";
import type { TransactionFlags } from "../bindings/types.js";
import type { DocSyncClient } from "../index.js";
import { getDocArgsFromKey } from "../queries/getDoc/getDocKey.js";
import { activeDocIds, hasActiveDocQuery } from "./activeDocQuery.js";
import { applyPresencePatch } from "./applyPresencePatch.js";

type BroadcastSource = "network" | "local-broadcast";

export type BroadcastMessage<O> =
  | {
      type: "OPERATIONS";
      source: BroadcastSource;
      operations: O;
      docId: string;
      flags?: TransactionFlags;
      presence?: Record<string, unknown>;
    }
  | { type: "PRESENCE"; docId: string; presence: Record<string, unknown> };

export class BCHelper<D extends object, S extends object, O extends object> {
  private _channel: BroadcastChannel;
  private _closed = false;

  constructor(client: DocSyncClient<D, S, O>, userId: string) {
    this._channel = new BroadcastChannel(`docsync:${userId}`);
    this._channel.onmessage = (event: MessageEvent<BroadcastMessage<O>>) => {
      const message = event.data;
      if (message.type === "PRESENCE") {
        this._applyPresencePatch(client, message.docId, message.presence);
        return;
      }

      this._applyOperations(client, message);
      if (message.presence) {
        this._applyPresencePatch(client, message.docId, message.presence);
      }
    };
  }

  private _applyOperations(
    client: DocSyncClient<D, S, O>,
    message: Extract<BroadcastMessage<O>, { type: "OPERATIONS" }>,
  ) {
    const docBinding = client["_docBinding"];

    for (const query of client["_queryClient"].getQueryCache().getAll()) {
      const args = getDocArgsFromKey(query.queryKey);
      if (args?.id !== message.docId) continue;
      if (query.getObserversCount() === 0) continue;

      const data: unknown = query.state.data;
      if (!isExistingGetDocData(data, docBinding)) continue;

      client["_changeOrigin"] = message.source;
      try {
        docBinding.applyOperations(
          data.doc,
          message.operations,
          message.source === "network"
            ? { ...message.flags, skipUndo: true }
            : message.flags,
        );
      } finally {
        client["_changeOrigin"] = "local";
      }
      return;
    }
  }

  private _applyPresencePatch(
    client: DocSyncClient<D, S, O>,
    docId: string,
    presence: Record<string, unknown>,
  ) {
    if (!hasActiveDocQuery(client, docId)) return;

    const presenceByDoc = client["_presenceStateByDocId"];
    const currentState = presenceByDoc.get(docId);
    const nextPresence = applyPresencePatch(
      client["_clientId"],
      currentState?.presence,
      presence,
    );
    if (nextPresence === undefined) return;

    if (!currentState) {
      presenceByDoc.set(docId, {
        presence: nextPresence,
        listeners: new Set(),
      });
      return;
    }

    currentState.presence = nextPresence;
    for (const listener of currentState.listeners) listener(nextPresence);
  }

  broadcast(message: BroadcastMessage<O>): void {
    if (this._closed) return;
    this._channel.postMessage(message);
  }

  broadcastPresenceRemoval(
    client: DocSyncClient<D, S, O>,
    clientId: string,
  ): void {
    for (const docId of activeDocIds(client)) {
      this.broadcast({
        type: "PRESENCE",
        docId,
        presence: { [clientId]: null },
      });
    }
  }

  close(): void {
    this._closed = true;
    this._channel.close();
  }
}
