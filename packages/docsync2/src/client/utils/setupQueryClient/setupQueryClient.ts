import type { DocSyncClient } from "../../index.js";
import { observeActiveGetDocQueries } from "./getDocQueries/observeActiveGetDocQueries.js";

export const setupQueryClient = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
): void => {
  const { queryClient } = client.config;

  // query-core has no framework provider here; mount wires this client to
  // onlineManager so paused queries resume when the socket reconnects.
  // onlineManager is global and may affect other TanStack Query clients in the app.
  // If this becomes a problem, consider a TanStack Query PR for per-client online managers.
  // https://github.com/TanStack/query/blob/v5.101.0/packages/query-core/src/queryClient.ts
  queryClient.mount();

  observeActiveGetDocQueries(client);
};
