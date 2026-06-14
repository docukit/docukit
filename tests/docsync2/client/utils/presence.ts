import { QueryObserver } from "@tanstack/query-core";
import type { TestClient } from "./client.js";

export const observePresence = (
  { queryClient, docSync }: TestClient,
  docId: string,
) => {
  const observer = new QueryObserver(
    queryClient,
    docSync.queries.getDocPresence({ docId }),
  );
  const results = [observer.getCurrentResult()];
  const unsubscribe = observer.subscribe((result) => {
    results.push(result);
  });

  return { observer, results, unsubscribe };
};

type ObservedPresence = ReturnType<typeof observePresence>;

export const waitForObservedPresenceResult = (
  observed: ObservedPresence,
  predicate: (result: ObservedPresence["results"][number]) => boolean,
) => {
  const existing = observed.results.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise<ObservedPresence["results"][number]>((resolve) => {
    const unsubscribe = observed.observer.subscribe((result) => {
      if (!predicate(result)) return;

      unsubscribe();
      resolve(result);
    });
  });
};

export const waitForNextPresenceResult = (
  observed: ObservedPresence,
  predicate: (result: ObservedPresence["results"][number]) => boolean,
) => {
  return new Promise<ObservedPresence["results"][number]>((resolve) => {
    const unsubscribe = observed.observer.subscribe((result) => {
      if (!predicate(result)) return;

      unsubscribe();
      resolve(result);
    });
  });
};
