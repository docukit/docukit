import type { Presence } from "@docukit/docsync2/client";
import type { TestClient } from "./client.js";

export const observePresence = ({ docSync }: TestClient, docId: string) => {
  let currentPresence: Presence = {};
  const results: Presence[] = [];
  const listeners = new Set<(presence: Presence) => void>();
  const unsubscribePresence = docSync.queries.getDocPresence(
    { docId },
    (presence) => {
      currentPresence = presence;
      results.push(presence);
      for (const listener of listeners) listener(presence);
    },
  );

  const subscribe = (listener: (presence: Presence) => void) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  };

  const unsubscribe = () => {
    listeners.clear();
    unsubscribePresence();
  };

  return {
    getCurrentPresence: () => currentPresence,
    results,
    subscribe,
    unsubscribe,
  };
};

type ObservedPresence = ReturnType<typeof observePresence>;

export const waitForObservedPresenceResult = (
  observed: ObservedPresence,
  predicate: (result: ObservedPresence["results"][number]) => boolean,
) => {
  const existing = observed.results.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise<ObservedPresence["results"][number]>((resolve) => {
    const unsubscribe = observed.subscribe((presence) => {
      if (!predicate(presence)) return;

      unsubscribe();
      resolve(presence);
    });
  });
};

export const waitForNextPresenceResult = (
  observed: ObservedPresence,
  predicate: (result: ObservedPresence["results"][number]) => boolean,
) => {
  return new Promise<ObservedPresence["results"][number]>((resolve) => {
    const unsubscribe = observed.subscribe((presence) => {
      if (!predicate(presence)) return;

      unsubscribe();
      resolve(presence);
    });
  });
};
