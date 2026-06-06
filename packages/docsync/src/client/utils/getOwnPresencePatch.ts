/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { DocSyncClient } from "../index.js";

export function getOwnPresencePatch<D extends {}, S extends {}, O extends {}>(
  client: DocSyncClient<D, S, O>,
  docId: string,
): Record<string, unknown> | undefined {
  const state = client["_presenceDebounceState"].get(docId);
  if (state) return { [client["_clientId"]]: state.data };
  return undefined;
}
