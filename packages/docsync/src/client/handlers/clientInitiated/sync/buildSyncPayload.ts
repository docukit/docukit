/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { SyncRequest } from "../../../../shared/types.js";
import type { DocSyncClient } from "../../../index.js";
import type { DeferredState } from "../../../types.js";

export type BuildSyncPayloadResult<O> = {
  payload: SyncRequest<O>;
  req: { docId: string; operations: O[]; clock: number };
  operationsBatches: O[][];
};

type CacheEntryWithPresence = { presenceDebounceState: DeferredState<unknown> };

/**
 * Reads operations and clock from provider, flushes presence debounce, and
 * builds the sync request payload and req object for events.
 */
export async function buildSyncPayload<
  D extends {},
  S extends {},
  O extends {},
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  cacheEntry: CacheEntryWithPresence,
): Promise<BuildSyncPayloadResult<O>> {
  const { provider } = await client["_localPromise"];

  const [rawBatches, stored] = await provider.transaction(
    "readonly",
    async (ctx) => {
      return Promise.all([
        ctx.getOperations({ docId }),
        ctx.getSerializedDoc(docId),
      ]);
    },
  );
  const operationsBatches = rawBatches === "deleted" ? [] : rawBatches;
  const operations = operationsBatches.flat();
  const clientClock = stored?.clock ?? 0;

  const presenceState = cacheEntry.presenceDebounceState;
  let presence: unknown;
  if (presenceState !== undefined) {
    clearTimeout(presenceState.timeout);
    presence = presenceState.data;
    cacheEntry.presenceDebounceState = undefined;
    client["_bcHelper"]?.broadcast({
      type: "PRESENCE",
      docId,
      presence: { [client["_clientId"]]: presence },
    });
  }

  const payload: SyncRequest<O> = {
    clock: clientClock,
    docId,
    operations,
    ...(presence !== undefined ? { presence } : {}),
  };
  const req = { docId, operations, clock: clientClock };

  return { payload, req, operationsBatches };
}
