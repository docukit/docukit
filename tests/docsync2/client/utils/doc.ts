import { QueryObserver } from "@tanstack/query-core";
import type { FetchStatus } from "@tanstack/query-core";
import { getDocKey, isExistingGetDocData } from "@docukit/docsync2/client";
import type { TestClient } from "./client.js";

export const createTestDoc = async (
  testClient: TestClient,
  docArgs = testClient.docArgs,
) => {
  const { queryClient, docSync } = testClient;
  await docSync.mutations.createDoc(docArgs);
  const data = queryClient.getQueryData(getDocKey(docArgs));
  if (!isExistingGetDocData(data, docSync.config.docBinding)) {
    throw new Error("Expected createDoc to seed getDoc data");
  }

  return data;
};

export const getTestDocKey = ({ docArgs }: TestClient) => getDocKey(docArgs);

export const observeDoc = (
  { queryClient, docSync }: TestClient,
  docArgs: TestClient["docArgs"],
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
      isExistingGetDocData(result.data, testClient.docSync.config.docBinding),
  );
  const { data } = result;
  if (!isExistingGetDocData(data, testClient.docSync.config.docBinding)) {
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
