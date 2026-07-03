import { QueryObserver } from "@tanstack/query-core";
import type { FetchStatus } from "@tanstack/query-core";
import {
  getDocKey,
  isExistingGetDocData,
  type GetDocArgs,
} from "@docukit/docsync2/client";
import type { TestClient } from "./client.js";

export const createTestDoc = async (
  testClient: TestClient,
  docArgs = testClient.docArgs,
) => {
  const observed = observeDoc(testClient, {
    ...docArgs,
    createIfMissing: true,
  });
  try {
    const { data } = await waitForDocStatus(testClient, observed, "idle");
    return data;
  } finally {
    observed.unsubscribe();
  }
};

export const getTestDocKey = ({ docArgs }: TestClient) => getDocKey(docArgs);

export const observeDoc = (
  { queryClient, docSync }: TestClient,
  docArgs: GetDocArgs,
) => {
  const observer = new QueryObserver(
    queryClient,
    docSync.queries.getDoc(docArgs),
  );
  const results = [observer.getCurrentResult()];
  const unsubscribe = observer.subscribe((result) => {
    results.push(result);
  });

  return { observer, results, unsubscribe };
};

export const observeTestDoc = (testClient: TestClient) =>
  observeDoc(testClient, testClient.docArgs);

export const waitForObservedDocResult = (
  observed: ReturnType<typeof observeDoc>,
  predicate: (result: (typeof observed.results)[number]) => boolean,
) => {
  const existing = observed.results.find(predicate);
  if (existing) return Promise.resolve(existing);

  return new Promise<(typeof observed.results)[number]>((resolve) => {
    const unsubscribe = observed.observer.subscribe((result) => {
      if (!predicate(result)) return;

      unsubscribe();
      resolve(result);
    });
  });
};

export const waitForObservedTestDocResult = waitForObservedDocResult;

export const waitForNextDocResult = (
  observed: ReturnType<typeof observeDoc>,
  predicate: (result: (typeof observed.results)[number]) => boolean,
) => {
  return new Promise<(typeof observed.results)[number]>((resolve) => {
    const unsubscribe = observed.observer.subscribe((result) => {
      if (!predicate(result)) return;

      unsubscribe();
      resolve(result);
    });
  });
};

export const waitForDocStatus = async (
  testClient: TestClient,
  observed: ReturnType<typeof observeDoc>,
  fetchStatus: FetchStatus,
) => {
  const result = await waitForObservedDocResult(
    observed,
    (result) =>
      result.fetchStatus === fetchStatus &&
      isExistingGetDocData(result.data, testClient.docBinding),
  );
  const { data } = result;
  if (!isExistingGetDocData(data, testClient.docBinding)) {
    throw new Error(`Expected existing getDoc data while ${fetchStatus}`);
  }

  return { result, data };
};

export const getTestDocOperationBatchCount = async (
  { provider }: TestClient,
  docId: string,
) => {
  const operations = await provider.transaction("readonly", (ctx) =>
    ctx.getOperations({ docId }),
  );

  return operations.length;
};
