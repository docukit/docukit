import type { QueryClient } from "@tanstack/query-core";
import type { DocBinding } from "../../../shared/types.js";
import { isExistingGetDocData } from "../../../shared/validators/getDocData.js";
import { isGetDocKey } from "../../../shared/validators/getDocKey.js";

export const observeActiveGetDocQueries = <
  D extends object,
  S extends object,
  O extends object,
>(
  queryClient: QueryClient,
  docBinding: DocBinding<D, S, O>,
): void => {
  const observedQueries = new WeakSet<object>();

  void queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "observerAdded" && event.type !== "updated") return;

    const { query } = event;
    if (query.getObserversCount() === 0) return;
    if (observedQueries.has(query)) return;
    if (!isGetDocKey(query.queryKey)) return;

    const data: unknown = query.state.data;
    if (!isExistingGetDocData(data, docBinding)) return;

    observedQueries.add(query);
    void docBinding.onChange(data.doc, () => {
      // TODO: Persist local operations and propagate them through the socket.
    });
  });
};
