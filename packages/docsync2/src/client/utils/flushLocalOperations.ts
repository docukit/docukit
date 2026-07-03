import type { DocSyncClient } from "../index.js";
import { invalidateDoc } from "./invalidateDoc.js";

export const flushLocalOperations = async <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  options?: { invalidate?: boolean },
) => {
  const state = client["_localOpsBatchState"].get(docId);
  if (!state) return false;

  if (state.timeout !== undefined) {
    clearTimeout(state.timeout);
  }
  client["_localOpsBatchState"].delete(docId);

  const operations = state.data;
  if (operations.length === 0) return false;

  const { provider } = await client["_localPromise"];
  await provider.transaction("readwrite", (ctx) =>
    ctx.saveOperations({ docId, operations }),
  );
  if (options?.invalidate !== false) {
    await invalidateDoc(client, docId);
  }

  return true;
};
