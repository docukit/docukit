import type { PresenceRequest } from "../../shared/types.js";
import type { DocSyncClient } from "../index.js";
import { getDocArgsFromKey } from "../queries/getDoc/getDocKey.js";
import { request } from "../utils/request.js";

export type SetDocPresenceArgs<TPresence = unknown> = {
  docId: string;
  presence: TPresence;
};

const ensureActiveDocQuery = <
  D extends object,
  S extends object,
  O extends object,
>(
  docSync: DocSyncClient<D, S, O>,
  docId: string,
) => {
  const hasActiveDocQuery = docSync["_queryClient"]
    .getQueryCache()
    .getAll()
    .some((query) => {
      const docArgs = getDocArgsFromKey(query.queryKey);
      return docArgs?.id === docId && query.getObserversCount() > 0;
    });
  if (!hasActiveDocQuery) {
    throw new Error(`Doc ${docId} is not loaded, cannot set presence`);
  }
};

const sendDocPresence = <D extends object, S extends object, O extends object>(
  docSync: DocSyncClient<D, S, O>,
  args: SetDocPresenceArgs,
) => {
  ensureActiveDocQuery(docSync, args.docId);

  const queryClient = docSync["_queryClient"];
  const mutation = queryClient.getMutationCache().build(queryClient, {
    mutationKey: ["docsync", "presence", args.docId],
    networkMode: "online",
    mutationFn: async () => {
      ensureActiveDocQuery(docSync, args.docId);

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

const flushDocPresence = async <
  D extends object,
  S extends object,
  O extends object,
>(
  docSync: DocSyncClient<D, S, O>,
  docId: string,
) => {
  const state = docSync["_presenceDebounceState"].get(docId);
  if (!state) return;

  if (state.timeout !== undefined) {
    clearTimeout(state.timeout);
  }
  docSync["_presenceDebounceState"].delete(docId);

  try {
    await sendDocPresence(docSync, { docId, presence: state.data });
    for (const resolve of state.resolves) resolve();
  } catch (error) {
    for (const reject of state.rejects) reject(error);
  }
};

export const setDocPresence = async <
  D extends object,
  S extends object,
  O extends object,
  TPresence = unknown,
>(
  docSync: DocSyncClient<D, S, O>,
  args: SetDocPresenceArgs<TPresence>,
): Promise<void> => {
  ensureActiveDocQuery(docSync, args.docId);

  const maxDebounce = docSync["_collabMaxDebounce"];
  if (maxDebounce === 0) {
    await sendDocPresence(docSync, args);
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const state = docSync["_presenceDebounceState"].get(args.docId) ?? {
      data: args.presence,
      resolves: new Set<() => void>(),
      rejects: new Set<(error: unknown) => void>(),
    };
    state.data = args.presence;
    state.resolves.add(resolve);
    state.rejects.add(reject);

    state.timeout ??= setTimeout(() => {
      void flushDocPresence(docSync, args.docId);
    }, maxDebounce);

    docSync["_presenceDebounceState"].set(args.docId, state);
  });
};
