import type { DocSyncClient } from "../index.js";
import { handleSync } from "../handlers/clientInitiated/sync/sync.js";

export async function deleteDocMethod<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(client: DocSyncClient<D, S, O>, args: { docId: string }): Promise<void> {
  const docId = args.docId;
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return;
  if ((await cacheEntry.promisedDoc) === "deleted") return;

  const state = cacheEntry.localOpsBatchState;
  if (state) clearTimeout(state.timeout);
  cacheEntry.localOpsBatchState = undefined;

  const local = await client["_localPromise"];
  await local?.provider.transaction("readwrite", (ctx) =>
    ctx.saveOperations({ docId, operations: "deleted" }),
  );
  client["_docsCache"].set(docId, {
    ...cacheEntry,
    promisedDoc: Promise.resolve("deleted"),
  });
  void handleSync(client, docId);
}
