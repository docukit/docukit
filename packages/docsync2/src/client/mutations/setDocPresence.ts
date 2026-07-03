import type { PresenceRequest } from "../../shared/types.js";
import type { DocSyncClient } from "../index.js";
import { ensureActiveDocQuery } from "../utils/activeDocQuery.js";
import { request } from "../utils/request.js";

export type SetDocPresenceArgs<TPresence = unknown> = {
  docId: string;
  presence: TPresence;
};

const sendDocPresence = async <
  D extends object,
  S extends object,
  O extends object,
>(
  docSync: DocSyncClient<D, S, O>,
  args: SetDocPresenceArgs,
) => {
  ensureActiveDocQuery(docSync, args.docId);

  docSync["_bcHelper"]?.broadcast({
    type: "PRESENCE",
    docId: args.docId,
    presence: { [docSync["_clientId"]]: args.presence },
  });

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
