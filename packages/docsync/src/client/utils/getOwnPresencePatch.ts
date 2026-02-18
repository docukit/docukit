import type { DocSyncClient } from "../index.js";

export function getOwnPresencePatch(
  client: DocSyncClient,
  docId: string,
): Record<string, unknown> | undefined {
  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) return undefined;
  if (cacheEntry.presenceDebounceState !== undefined)
    return { [client["_clientId"]]: cacheEntry.presenceDebounceState.data };
  if (cacheEntry.presence[client["_clientId"]] !== undefined)
    return { [client["_clientId"]]: cacheEntry.presence[client["_clientId"]] };
  return undefined;
}
