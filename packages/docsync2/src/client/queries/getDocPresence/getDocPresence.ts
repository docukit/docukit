import type { Presence } from "../../../shared/types.js";
import type { DocSyncClient } from "../../index.js";
import { ensureActiveDocQuery } from "../../utils/activeDocQuery.js";

export const getDocPresence =
  <D extends object, S extends object, O extends object>(
    docSync: DocSyncClient<D, S, O>,
  ) =>
  ({ docId }: { docId: string }, onChange: (presence: Presence) => void) => {
    ensureActiveDocQuery(docSync, docId);

    const presenceByDoc = docSync["_presenceStateByDocId"];
    const currentState = presenceByDoc.get(docId) ?? {
      presence: {},
      listeners: new Set<(presence: Presence) => void>(),
    };
    if (!presenceByDoc.has(docId)) {
      presenceByDoc.set(docId, currentState);
    }
    currentState.listeners.add(onChange);
    onChange(currentState.presence);

    return () => {
      const currentState = presenceByDoc.get(docId);
      if (!currentState) return;

      currentState.listeners.delete(onChange);
      if (
        currentState.listeners.size === 0 &&
        Object.keys(currentState.presence).length === 0
      ) {
        presenceByDoc.delete(docId);
      }
    };
  };
