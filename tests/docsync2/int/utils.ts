import { expect } from "vitest";
import { tick } from "../client/utils/async.js";
import { createTestClient, type TestClient } from "../client/utils/client.js";
import {
  createTestDoc,
  observeDoc,
  waitForObservedDocResult,
} from "../client/utils/doc.js";

const cleanupClient = async (
  testClient: TestClient,
  unsubscribes: (() => void)[],
) => {
  for (const unsubscribe of unsubscribes.splice(0)) {
    unsubscribe();
  }

  testClient.docSync.disconnect();
  testClient.docSync.dispose();
  await tick();
};

type ObservedDoc = ReturnType<typeof observeDoc>;

type ClientUtils = TestClient & {
  createDoc(docArgs?: TestClient["docArgs"]): ReturnType<typeof createTestDoc>;
  observeDoc(docArgs?: TestClient["docArgs"]): ObservedDoc;
  invalidateDoc(docArgs?: TestClient["docArgs"]): void;
  waitForRemoteIdle(
    observed: ObservedDoc,
    previousUpdatedAt?: number,
  ): ReturnType<typeof waitForObservedDocResult>;
  cleanup(): Promise<void>;
};

const createClientUtils = (): ClientUtils => {
  const testClient = createTestClient();
  const unsubscribes: (() => void)[] = [];

  return {
    ...testClient,
    createDoc: (docArgs = testClient.docArgs) =>
      createTestDoc(testClient, docArgs),
    observeDoc: (docArgs = testClient.docArgs) => {
      const observed = observeDoc(testClient, docArgs);
      unsubscribes.push(observed.unsubscribe);
      return observed;
    },
    invalidateDoc: (docArgs = testClient.docArgs) => {
      void testClient.queryClient.invalidateQueries({
        queryKey: testClient.docSync.queries.getDoc(docArgs).queryKey,
      });
    },
    waitForRemoteIdle: (
      observed: ReturnType<typeof observeDoc>,
      previousUpdatedAt = 0,
    ) =>
      waitForObservedDocResult(
        observed,
        (result) =>
          result.fetchStatus === "idle" &&
          result.dataUpdatedAt > previousUpdatedAt,
      ),
    cleanup: () => cleanupClient(testClient, unsubscribes),
  };
};

export const testWrapper = async (
  callback: (clients: { reference: ClientUtils }) => Promise<void>,
) => {
  const reference = createClientUtils();

  try {
    await callback({ reference });
  } finally {
    await reference.cleanup();
  }
};

export const expectParallelFetching = async (
  observed1: ReturnType<typeof observeDoc>,
  observed2: ReturnType<typeof observeDoc>,
) => {
  let sawParallelFetching = false;
  const update = () => {
    const result1 = observed1.observer.getCurrentResult();
    const result2 = observed2.observer.getCurrentResult();
    if (
      result1.fetchStatus === "fetching" &&
      result2.fetchStatus === "fetching"
    ) {
      sawParallelFetching = true;
    }
  };

  const unsubscribe1 = observed1.observer.subscribe(update);
  const unsubscribe2 = observed2.observer.subscribe(update);
  update();

  await Promise.all([
    waitForObservedDocResult(
      observed1,
      (result) => result.fetchStatus === "idle" && result.dataUpdatedAt > 0,
    ),
    waitForObservedDocResult(
      observed2,
      (result) => result.fetchStatus === "idle" && result.dataUpdatedAt > 0,
    ),
  ]);

  unsubscribe1();
  unsubscribe2();
  expect(sawParallelFetching).toBe(true);
};
