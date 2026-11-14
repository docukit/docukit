import { expect } from "vitest";
import type { Doc, JsonDoc, Operations } from "@docukit/docnode";
import type { ClientEventMap, GetDocArgs } from "@docukit/docsync2/client";
import { tick } from "../client/utils/async.js";
import {
  createTestClient,
  TestNode,
  type TestClient,
} from "../client/utils/client.js";
import { disconnectTestClient } from "../client/utils/connection.js";
import {
  createTestDoc,
  observeDoc,
  waitForDocStatus,
  waitForNextDocResult,
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

/** What one sync carried in each direction. */
const summarizeSync = (event: ClientEventMap<Operations, JsonDoc>["sync"]) =>
  event.error
    ? { error: event.error.type }
    : {
        sentDoc: event.req.serializedDoc !== undefined,
        sentOperations: event.req.operations.length,
        receivedDoc: event.data.serializedDoc !== null,
      };

type SyncSummary = ReturnType<typeof summarizeSync>;

export const appendTestNode = (doc: Doc) => {
  doc.root.append(doc.createNode(TestNode));
  doc.forceCommit();
};

type ClientUtils = TestClient & {
  createMissingDoc(
    docArgs?: TestClient["docArgs"],
  ): ReturnType<typeof createTestDoc>;
  observeDoc(docArgs?: GetDocArgs): ObservedDoc;
  invalidateDoc(docArgs?: TestClient["docArgs"]): void;
  waitForRemoteIdle(
    observed: ObservedDoc,
    previousUpdatedAt?: number,
  ): ReturnType<typeof waitForObservedDocResult>;
  /** Records a summary of every sync of this client's doc from now on. */
  recordSyncs(): SyncSummary[];
  /** Appends a node and waits until the server confirmed that operation. */
  editAndSync(observed: ObservedDoc): Promise<void>;
  /** Creates the doc locally while the client is offline. */
  createDocOffline(): Promise<{ observed: ObservedDoc; doc: Doc }>;
  cleanup(): Promise<void>;
};

const createClientUtils = (
  options?: Parameters<typeof createTestClient>[0],
): ClientUtils => {
  const testClient = createTestClient(options);
  const unsubscribes: (() => void)[] = [];

  const observeClientDoc = (docArgs: GetDocArgs = testClient.docArgs) => {
    const observed = observeDoc(testClient, docArgs);
    unsubscribes.push(observed.unsubscribe);
    return observed;
  };

  const getObservedDoc = (observed: ObservedDoc) => {
    const { data } = observed.observer.getCurrentResult();
    if (!data?.doc) throw new Error("Expected an observed doc");
    return data.doc;
  };

  return {
    ...testClient,
    createMissingDoc: (docArgs = testClient.docArgs) =>
      createTestDoc(testClient, docArgs),
    observeDoc: observeClientDoc,
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
    recordSyncs: () => {
      const syncs: SyncSummary[] = [];
      const off = testClient.docSync.on("sync", (event) => {
        if (event.req.docId !== testClient.docArgs.id) return;
        syncs.push(summarizeSync(event));
      });
      unsubscribes.push(off);
      return syncs;
    },
    editAndSync: async (observed) => {
      const synced = new Promise<void>((resolve, reject) => {
        const off = testClient.docSync.on("sync", (event) => {
          if (event.req.docId !== testClient.docArgs.id) return;
          if (event.req.operations.length === 0) return;

          off();
          if (event.error) reject(new Error(event.error.message));
          else resolve();
        });
      });
      appendTestNode(getObservedDoc(observed));
      await synced;
      // The sync event fires before the response is written to IndexedDB.
      await waitForNextDocResult(
        observed,
        (result) => result.fetchStatus === "idle",
      );
    },
    createDocOffline: async () => {
      await testClient.docSync["_localPromise"];
      await disconnectTestClient(testClient);
      const observed = observeClientDoc({
        ...testClient.docArgs,
        createIfMissing: true,
      });
      const { data } = await waitForDocStatus(testClient, observed, "paused");
      return { observed, doc: data.doc };
    },
    cleanup: () => cleanupClient(testClient, unsubscribes),
  };
};

export const testWrapper = async (
  callback: (clients: { reference: ClientUtils }) => Promise<void>,
  options?: Parameters<typeof createTestClient>[0],
) => {
  const reference = createClientUtils(options);

  try {
    await callback({ reference });
  } finally {
    await reference.cleanup();
  }
};

/** Opens the reference doc on a fresh client and expects the same content. */
export const expectPeerToConverge = async (
  reference: TestClient,
  referenceDoc: Doc,
) => {
  const peer = createTestClient();
  const observed = observeDoc(peer, reference.docArgs);
  try {
    const { data } = await waitForDocStatus(peer, observed, "idle");
    expect(data.doc.toJSON()).toStrictEqual(referenceDoc.toJSON());
  } finally {
    observed.unsubscribe();
    peer.docSync.disconnect();
    peer.docSync.dispose();
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
