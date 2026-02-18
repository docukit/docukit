/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../../../index.js";
import { getOwnPresencePatch } from "../../../utils/getOwnPresencePatch.js";
import { applyServerOperations } from "./applyServerOperations.js";

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
