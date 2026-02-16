/* eslint-disable @typescript-eslint/no-empty-object-type */

/** Wire format for cross-tab BroadcastChannel messages. Only used in BCHelper. */
export type BroadcastMessage<O> =
  | {
      type: "OPERATIONS";
      operations: O;
      docId: string;
      presence?: Record<string, unknown>;
    }
  | { type: "PRESENCE"; docId: string; presence: Record<string, unknown> };

export type PushStatus = "idle" | "pushing" | "pushing-with-pending";

/** Cache entry shape required for presence patches. */
export type PresenceCacheEntry = {
  presence: Record<string, unknown>;
  presenceHandlers: Set<(p: Record<string, unknown>) => void>;
};

export type BCHelperDeps<O> = {
  pushStatusByDocId: Map<string, PushStatus>;
  getCacheEntry: (docId: string) => PresenceCacheEntry | undefined;
  applyOperations: (operations: O, docId: string) => void | Promise<void>;
  applyPresencePatch: (
    cacheEntry: PresenceCacheEntry,
    patch: Record<string, unknown>,
  ) => void;
};

/**
 * Thin wrapper around BroadcastChannel for DocSync cross-tab messaging.
 * Only public method: broadcast(message). All message handling runs inside the constructor.
 */
export class BCHelper<O extends {} = {}> {
  private _channel: BroadcastChannel;

  constructor(channelName: string, deps: BCHelperDeps<O>) {
    this._channel = new BroadcastChannel(channelName);
    this._channel.onmessage = (ev: MessageEvent<BroadcastMessage<O>>) => {
      const msg = ev.data;
      if (msg.type === "OPERATIONS") {
        const { docId, operations, presence } = msg;
        const currentStatus = deps.pushStatusByDocId.get(docId) ?? "idle";
        if (currentStatus === "pushing") {
          deps.pushStatusByDocId.set(docId, "pushing-with-pending");
        }
        void Promise.resolve(deps.applyOperations(operations, docId));
        if (presence) {
          const cacheEntry = deps.getCacheEntry(docId);
          if (cacheEntry) deps.applyPresencePatch(cacheEntry, presence);
        }
        return;
      }
      if (msg.type === "PRESENCE") {
        const { docId, presence } = msg;
        const cacheEntry = deps.getCacheEntry(docId);
        if (!cacheEntry) return;
        deps.applyPresencePatch(cacheEntry, presence);
      }
    };
  }

  broadcast(message: BroadcastMessage<O>): void {
    this._channel.postMessage(message);
  }

  /** Close the underlying channel (e.g. for test cleanup). */
  close(): void {
    this._channel.close();
  }
}
