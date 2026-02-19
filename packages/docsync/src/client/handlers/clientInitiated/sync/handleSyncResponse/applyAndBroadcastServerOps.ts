import type { DocSyncClient } from "../../../../index.js";
import { getOwnPresencePatch } from "../../../../utils/getOwnPresencePatch.js";

/**
 * Applies server operations to the cached doc (emit change) and broadcasts
 * each operation to other tabs with optional presence patch.
 */
export async function applyAndBroadcastServerOps<
  D extends {},
  S extends {},
  O extends {},
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  operations: O[],
): Promise<void> {
  if (operations.length === 0) return;

  await applyServerOperations(client, { docId, operations });

  const presencePatch = getOwnPresencePatch(client, docId);
  for (const op of operations) {
    client["_bcHelper"]?.broadcast({
      type: "OPERATIONS",
      operations: op,
      docId,
      ...(presencePatch && { presence: presencePatch }),
    });
  }
}

/** Applies server operations to the cached doc and emits change event (remote). */
export async function applyServerOperations<
  D extends {},
  S extends {},
  O extends {},
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; operations: O[] },
): Promise<void> {
  const cacheEntry = client["_docsCache"].get(args.docId);
  if (!cacheEntry) return;

  const doc = await cacheEntry.promisedDoc;
  if (!doc || doc === "deleted") return;

  client["_shouldBroadcast"] = false;
  for (const op of args.operations) {
    client["_docBinding"].applyOperations(doc, op);
  }
  client["_shouldBroadcast"] = true;

  client["_events"].emit("change", {
    docId: args.docId,
    origin: "remote",
    operations: args.operations,
  });
}
