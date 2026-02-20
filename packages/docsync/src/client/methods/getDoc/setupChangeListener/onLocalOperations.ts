import type { DocSyncClient } from "../../../index.js";
import { handleSync } from "../../../handlers/clientInitiated/sync/sync.js";

export function onLocalOperations<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; operations: O[] },
): void {
  const { docId, operations } = args;
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;

  const runBatch = () => {
    void (async () => {
      const currentEntry = client["_docsCache"].get(docId);
      const currentState = currentEntry?.localOpsBatchState;
      if (!currentEntry || !currentState) return;

      const opsToSave = currentState.data;
      currentEntry.localOpsBatchState = undefined;

      if (opsToSave.length > 0) {
        const local = await client["_localPromise"];
        await local?.provider.transaction("readwrite", (ctx) =>
          ctx.saveOperations({ docId, operations: opsToSave }),
        );
        void handleSync(client, docId);
      }
    })();
  };

  const state = cacheEntry.localOpsBatchState;
  if (!state) {
    cacheEntry.localOpsBatchState = {
      data: operations.length > 0 ? [...operations] : [],
      timeout: setTimeout(runBatch, client["_batchDelay"]),
    };
    return;
  }
  if (operations.length > 0) state.data.push(...operations);
  if (state.timeout !== undefined) return;
  state.timeout = setTimeout(runBatch, client["_batchDelay"]);
}
