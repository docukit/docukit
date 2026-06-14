import { describe, expect, test } from "vitest";
import { tick } from "../client/utils/async.js";
import { createTestClient } from "../client/utils/client.js";
import { reconnectTestClient } from "../client/utils/connection.js";
import { createTestDocArgs } from "../client/utils/generators.js";
import { observeDoc, waitForDocStatus } from "../client/utils/doc.js";
import { expectParallelFetching, testWrapper } from "./utils.js";

describe("DocSync2 integration sync", () => {
  test("multiple invalidations for one doc share the active getDoc sync", async () => {
    await testWrapper(async ({ reference }) => {
      await reference.createDoc();
      reference.queryClient.clear();

      const syncEvents = reference.recordSyncs(reference.docArgs.id);
      const observed = reference.observeDoc();
      let invalidatedWhileFetching = false;
      const unsubscribe = observed.observer.subscribe((result) => {
        if (invalidatedWhileFetching) return;
        if (result.fetchStatus !== "fetching") return;

        invalidatedWhileFetching = true;
        for (let i = 0; i < 5; i++) {
          reference.invalidateDoc();
        }
      });

      await reference.waitForRemoteIdle(observed);
      await tick();

      unsubscribe();
      expect(invalidatedWhileFetching).toBe(true);
      expect(syncEvents).toHaveLength(1);
    });
  });

  test("getDoc syncs for different docs can fetch in parallel", async () => {
    await testWrapper(async ({ reference }) => {
      const doc1Args = reference.docArgs;
      const doc2Args = createTestDocArgs();
      await reference.createDoc(doc1Args);
      await reference.createDoc(doc2Args);
      reference.queryClient.clear();

      const observed1 = reference.observeDoc(doc1Args);
      const observed2 = reference.observeDoc(doc2Args);

      await expectParallelFetching(observed1, observed2);
    });
  });

  test("created docs sync their initial serialized doc before local edits", async () => {
    await testWrapper(async ({ reference }) => {
      const created = await reference.createDoc();
      await reconnectTestClient(reference);
      reference.observeDoc();
      const synced = new Promise<void>((resolve, reject) => {
        const off = reference.docSync.on("sync", (event) => {
          if (event.req.docId !== reference.docArgs.id) return;

          off();
          if (event.error) {
            reject(new Error(event.error.message));
            return;
          }
          resolve();
        });
      });
      reference.invalidateDoc();
      await synced;

      const peer = createTestClient();
      const peerObserved = observeDoc(peer, reference.docArgs);
      try {
        const { data } = await waitForDocStatus(peer, peerObserved, "idle");
        expect(data.doc.toJSON()).toStrictEqual(created.doc.toJSON());
      } finally {
        peerObserved.unsubscribe();
        peer.docSync.disconnect();
        peer.docSync.dispose();
      }
    });
  });
});
