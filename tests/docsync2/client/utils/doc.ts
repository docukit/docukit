import { QueryObserver } from "@tanstack/query-core";
import { getDocKey } from "@docukit/docsync2/client";
import type { createTestClient } from "./client.js";

export const createTestDoc = ({
  docSync,
  docArgs,
}: ReturnType<typeof createTestClient>) => docSync.mutations.createDoc(docArgs);

export const getTestDocKey = ({
  docArgs,
}: ReturnType<typeof createTestClient>) => getDocKey(docArgs);

export const observeTestDoc = ({
  queryClient,
  docSync,
  docArgs,
}: ReturnType<typeof createTestClient>) => {
  const observer = new QueryObserver(
    queryClient,
    docSync.queries.getDoc(docArgs),
  );
  const unsubscribe = observer.subscribe(() => undefined);

  return { observer, unsubscribe };
};
