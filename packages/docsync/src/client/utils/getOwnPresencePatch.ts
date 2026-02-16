import type { DocSyncClient } from "../index.js";

export function getOwnPresencePatch(
  client: DocSyncClient,
  docId: string,
): Record<string, unknown> | undefined {
  const debounced = client["_presenceDebounceState"].get(docId);
  if (debounced) return { [client["_clientId"]]: debounced.data };
  const cacheEntry = client["_docsCache"].get(docId);
  if (cacheEntry?.presence[client["_clientId"]] !== undefined)
    return { [client["_clientId"]]: cacheEntry.presence[client["_clientId"]] };
  return undefined;
}
