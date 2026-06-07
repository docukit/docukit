import type { DocSync2Client } from "../../index.js";
import { observeActiveGetDocQueries } from "./observeActiveGetDocQueries.js";

export const setupQueryClient = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSync2Client<D, S, O>,
): void => {
  const { queryClient } = client.config;

  queryClient.setQueryDefaults(["docsync2"], {
    // We update queries in real-time via ws, so we don't need to re-fetch.
    staleTime: Infinity,
  });

  observeActiveGetDocQueries(queryClient, client.config.docBinding);
};
