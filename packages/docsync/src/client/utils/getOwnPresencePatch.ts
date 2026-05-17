import type { DocSyncClient } from "../index.js";

export function getOwnPresencePatch(
  client: DocSyncClient,
  docId: string,
): Record<string, unknown> | undefined {
  const state = client["_presenceDebounceState"].get(docId);
  if (state) return { [client["_clientId"]]: state.data };
  return undefined;
}
