import type { DocSyncClient } from "../../index.js";
import { hasActiveDocQuery } from "../../utils/activeDocQuery.js";
import { applyPresencePatch } from "../../utils/applyPresencePatch.js";

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
    if (!hasActiveDocQuery(client, docId)) return;

    const presenceByDoc = client["_presenceStateByDocId"];
    const currentState = presenceByDoc.get(docId);
    const nextPresence = applyPresencePatch(
      client["_clientId"],
      currentState?.presence,
      presence,
    );
    if (nextPresence === undefined) return;

    if (!currentState) {
      presenceByDoc.set(docId, {
        presence: nextPresence,
        listeners: new Set(),
      });
      return;
    }

    currentState.presence = nextPresence;
    for (const listener of currentState.listeners) listener(nextPresence);
  });
};
