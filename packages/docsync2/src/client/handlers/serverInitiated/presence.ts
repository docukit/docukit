import * as v from "valibot";
import type { Presence } from "../../../shared/types.js";
import { presenceSchema } from "../../../shared/validators/socketProtocol.js";
import type { DocSyncClient } from "../../index.js";
import { getDocPresenceKey } from "../../queries/getDocPresence/getDocPresence.js";

const getCachedPresence = (value: unknown): Presence => {
  const parsed = v.safeParse(presenceSchema, value);
  if (parsed.success) return parsed.output;

  return {};
};

const applyPresencePatch = (
  clientId: string,
  currentPresence: unknown,
  patch: Presence,
) => {
  let nextPresence = getCachedPresence(currentPresence);
  let changed = false;

  for (const [key, value] of Object.entries(patch)) {
    if (key === clientId) continue;

    if (value === null || value === undefined) {
      if (!(key in nextPresence)) continue;
      if (!changed) {
        nextPresence = { ...nextPresence };
        changed = true;
      }
      delete nextPresence[key];
      continue;
    }

    if (nextPresence[key] === value) continue;
    if (!changed) {
      nextPresence = { ...nextPresence };
      changed = true;
    }
    nextPresence[key] = value;
  }

  return changed ? nextPresence : undefined;
};

export const handlePresence = <
  D extends object,
  S extends object,
  O extends object,
>({
  client,
}: {
  client: DocSyncClient<D, S, O>;
}) => {
  client["_socket"].on("presence", ({ docId, presence }) => {
    const queryKey = getDocPresenceKey({ docId });
    const nextPresence = applyPresencePatch(
      client["_clientId"],
      client["_queryClient"].getQueryData(queryKey),
      presence,
    );
    if (nextPresence === undefined) return;

    client["_queryClient"].setQueryData(queryKey, nextPresence);
  });
};
