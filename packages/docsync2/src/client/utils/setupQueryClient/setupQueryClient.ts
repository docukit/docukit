import type { DocSync2Client } from "../../index.js";
import type { NonNullableValue } from "../../../shared/types.js";
import { disposeRemovedGetDocQuery } from "./disposeRemovedGetDocQuery.js";

export const setupQueryClient = <
  D extends NonNullableValue,
  S extends NonNullableValue,
  O extends NonNullableValue,
>(
  client: DocSync2Client<D, S, O>,
): void => {
  const { queryClient, docBinding } = client.config;

  queryClient.setQueryDefaults(["docsync2"], {
    // We update queries in real-time via ws, so we don't need to re-fetch.
    staleTime: Infinity,
  });

  const unsubscribeQueryCache = queryClient
    .getQueryCache()
    .subscribe((event) => {
      disposeRemovedGetDocQuery(docBinding, event);
    });

  const unsubscribeDispose = client.on("dispose", () => {
    queryClient.removeQueries({ queryKey: ["docsync2"] });
    unsubscribeQueryCache();
    unsubscribeDispose();
  });
};
