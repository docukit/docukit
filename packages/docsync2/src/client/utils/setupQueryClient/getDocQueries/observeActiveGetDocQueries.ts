import { isExistingGetDocData } from "../../../../shared/validators/getDocData.js";
import type { DocSyncClient } from "../../../index.js";
import { getDocArgsFromKey } from "../../../queries/getDoc/getDocKey.js";
import { unsubscribeDoc } from "../../unsubscribeDoc.js";
import { onDocChanged } from "./onDocChanged.js";
import { seedCacheFromProvider } from "./seedCacheFromProvider.js";

export const observeActiveGetDocQueries = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
): void => {
  const observedDocsByQuery = new WeakMap<object, D>();
  const seededCreateByQuery = new WeakMap<object, boolean>();
  const unsubscribedQueries = new WeakSet<object>();
  const docBinding = client["_docBinding"];
  const queryClient = client["_queryClient"];

  void queryClient.getQueryCache().subscribe(({ query, type }) => {
    const keyArgs = getDocArgsFromKey(query.queryKey);
    if (!keyArgs) return;
    const args = {
      ...keyArgs,
      createIfMissing: query.options.meta?.createIfMissing === true,
    };

    if (query.getObserversCount() === 0) {
      client["_presenceStateByDocId"].delete(args.id);
      if (!unsubscribedQueries.has(query)) {
        unsubscribedQueries.add(query);
        void unsubscribeDoc(client, args.id);
      }
      return;
    }
    unsubscribedQueries.delete(query);

    if (type !== "observerAdded" && type !== "updated") return;

    const seededCreate = seededCreateByQuery.get(query);
    if (seededCreate === undefined || (args.createIfMissing && !seededCreate)) {
      seededCreateByQuery.set(query, args.createIfMissing);
      void seedCacheFromProvider(client, args);
    }

    const data: unknown = query.state.data;
    if (!isExistingGetDocData(data, docBinding)) return;
    if (observedDocsByQuery.get(query) === data.doc) return;

    observedDocsByQuery.set(query, data.doc);
    void docBinding.onChange(data.doc, (event) => {
      onDocChanged(client, args, event);
    });
  });
};
