import { notImplemented } from "../../../shared/notImplemented.js";
import type { Presence } from "../../../shared/types.js";
import type { PresenceQueryKey } from "../../../shared/validators/presenceQueryKey.js";

export type DocPresenceArgs = { docId: string };

export type DocPresenceOptions<TPresence = unknown> = {
  queryKey: PresenceQueryKey;
  queryFn: () => Promise<Presence<TPresence>>;
};

export const docPresence = <TPresence = unknown>({
  docId,
}: DocPresenceArgs): DocPresenceOptions<TPresence> => {
  return {
    queryKey: ["docsync2", "presence", docId],
    queryFn: () => Promise.reject(notImplemented()),
  };
};
