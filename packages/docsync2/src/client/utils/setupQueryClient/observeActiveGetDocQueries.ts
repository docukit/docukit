import type { DocSyncClient } from "../../index.js";
import { isExistingGetDocData } from "../../../shared/validators/getDocData.js";
import { getDocArgsFromKey } from "../../queries/getDoc/getDocKey.js";
import { seedLocalGetDocData } from "../../queries/getDoc/loadLocalGetDocData.js";
import { invalidateActiveGetDocQueries } from "./invalidateActiveGetDocQueries.js";

export const observeActiveGetDocQueries = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
): void => {
  const observedQueries = new WeakSet<object>();
  const seededQueries = new WeakSet<object>();
  const { queryClient, docBinding } = client.config;

  void queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "observerAdded" && event.type !== "updated") return;

    const { query } = event;
    if (query.getObserversCount() === 0) return;
    const args = getDocArgsFromKey(query.queryKey);
    if (!args) return;

    if (!seededQueries.has(query)) {
      seededQueries.add(query);
      void seedLocalGetDocData(client, args);
    }

    if (observedQueries.has(query)) return;

    const data: unknown = query.state.data;
    if (!isExistingGetDocData(data, docBinding)) return;

    observedQueries.add(query);
    void docBinding.onChange(data.doc, ({ operations }) => {
      const origin = client["_changeOrigin"];
      client["_events"].emit("change", {
        docId: args.id,
        origin,
        operation: operations,
      });

      if (origin !== "local") return;

      void client["_localPromise"].then(({ provider }) =>
        provider
          .transaction("readwrite", (ctx) =>
            ctx.saveOperations({ docId: args.id, operations: [operations] }),
          )
          .then(() =>
            invalidateActiveGetDocQueries(client, (queryArgs) => {
              return queryArgs.id === args.id;
            }),
          ),
      );
    });
  });
};
