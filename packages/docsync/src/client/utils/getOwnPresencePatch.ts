import type { DocSyncClient } from "../index.js";

export function getOwnPresencePatch(
  client: DocSyncClient,
  docId: string,
): Record<string, unknown> | undefined {
  const cacheEntry = client["_docsCache"].get(docId);
  const debounced = cacheEntry?.presenceDebounceState;
  if (debounced) return { [client["_clientId"]]: debounced.data };
  if (cacheEntry?.presence[client["_clientId"]] !== undefined)
    return { [client["_clientId"]]: cacheEntry.presence[client["_clientId"]] };
  return undefined;
}
