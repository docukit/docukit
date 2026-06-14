import type { PresenceRequest } from "../../shared/types.js";
import type { DocSyncClient } from "../index.js";
import { getDocArgsFromKey } from "../queries/getDoc/getDocKey.js";
import { request } from "../utils/request.js";

export type SetDocPresenceArgs<TPresence = unknown> = {
  docId: string;
  presence: TPresence;
};

export const setDocPresence = <
  D extends object,
  S extends object,
  O extends object,
  TPresence = unknown,
>(
  docSync: DocSyncClient<D, S, O>,
  args: SetDocPresenceArgs<TPresence>,
): Promise<void> => {
  const queryClient = docSync["_queryClient"];
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: ["docsync", "presence", args.docId],
    networkMode: "online",
    mutationFn: async () => {
      const hasActiveDocQuery = queryClient
        .getQueryCache()
        .getAll()
        .some((query) => {
          const docArgs = getDocArgsFromKey(query.queryKey);
          return docArgs?.id === args.docId && query.getObserversCount() > 0;
        });
      if (!hasActiveDocQuery) {
        throw new Error(`Doc ${args.docId} is not loaded, cannot set presence`);
      }

      const payload: PresenceRequest = {
        docId: args.docId,
        presence: args.presence,
      };
      const response = await request(docSync["_socket"], "presence", payload);
      if ("error" in response) {
        throw Object.assign(new Error(response.error.message), {
          type: response.error.type,
        });
      }
    },
    scope: { id: `docsync:presence:${args.docId}` },
  });

  return mutation.execute(undefined);
};
