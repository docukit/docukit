import type { Presence } from "../../../shared/types.js";
import type { PresenceQueryKey } from "../../../shared/validators/presenceQueryKey.js";

export const getDocPresenceKey = ({
  docId,
}: {
  docId: string;
}): PresenceQueryKey => ["docsync", "presence", docId];

export const getDocPresence = <TPresence = unknown>({
  docId,
}: {
  docId: string;
}) => {
  const createEmptyPresence = (): Presence<TPresence> => ({});

  return {
    queryKey: getDocPresenceKey({ docId }),
    staleTime: Infinity,
    initialData: createEmptyPresence,
    queryFn: () => Promise.resolve(createEmptyPresence()),
  };
};
