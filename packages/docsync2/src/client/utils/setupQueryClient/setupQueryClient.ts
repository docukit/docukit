import type { DocSyncClient } from "../../index.js";
import { observeActiveGetDocQueries } from "./observeActiveGetDocQueries.js";

export const setupQueryClient = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
): void => {
  const { queryClient } = client.config;

  queryClient.setQueryDefaults(["docsync"], {
    // We update queries in real-time via ws, so we don't need to re-fetch.
    staleTime: Infinity,
  });

  observeActiveGetDocQueries(queryClient, client.config.docBinding);
};
