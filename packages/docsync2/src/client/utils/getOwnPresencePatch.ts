import type { DocSyncClient } from "../index.js";

export const getOwnPresencePatch = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
): Record<string, unknown> | undefined => {
  const state = client["_presenceDebounceState"].get(docId);
  if (!state) return undefined;

  return { [client["_clientId"]]: state.data };
};
