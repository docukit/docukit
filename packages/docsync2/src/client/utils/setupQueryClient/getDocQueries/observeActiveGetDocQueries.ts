import { isExistingGetDocData } from "../../../../shared/validators/getDocData.js";
import type { DocSyncClient } from "../../../index.js";
import { getDocArgsFromKey } from "../../../queries/getDoc/getDocKey.js";
import { onDocChanged } from "./onDocChanged.js";
import { seedCacheFromProvider } from "./seedCacheFromProvider.js";

export const observeActiveGetDocQueries = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
): void => {
  const observedQueries = new WeakSet<object>();
  const seededQueries = new WeakSet<object>();
  const { docBinding, queryClient } = client["_config"];

  void queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "observerAdded" && event.type !== "updated") return;

    const { query } = event;
    if (query.getObserversCount() === 0) return;
    const args = getDocArgsFromKey(query.queryKey);
    if (!args) return;

    if (!seededQueries.has(query)) {
      seededQueries.add(query);
      void seedCacheFromProvider(client, args);
    }

    if (observedQueries.has(query)) return;

    const data: unknown = query.state.data;
    if (!isExistingGetDocData(data, docBinding)) return;

    observedQueries.add(query);
    void docBinding.onChange(data.doc, (event) => {
      onDocChanged(client, args, event);
    });
  });
};
