import { describe, expect, test } from "vitest";
import { createTestClient } from "../client/utils/client.js";
import { reconnectTestClient } from "../client/utils/connection.js";
import { createTestDocArgs } from "../client/utils/generators.js";
import { observeDoc, waitForDocStatus } from "../client/utils/doc.js";
import { expectParallelFetching, testWrapper } from "./utils.js";

describe("DocSync2 integration sync", () => {
  test("getDoc syncs for different docs can fetch in parallel", async () => {
    await testWrapper(async ({ reference }) => {
      const doc1Args = reference.docArgs;
      const doc2Args = createTestDocArgs();
      await reference.createMissingDoc(doc1Args);
      await reference.createMissingDoc(doc2Args);
      reference.queryClient.clear();

      const observed1 = reference.observeDoc(doc1Args);
      const observed2 = reference.observeDoc(doc2Args);

      await expectParallelFetching(observed1, observed2);
    });
  });

  test("created docs sync their initial serialized doc before local edits", async () => {
    await testWrapper(async ({ reference }) => {
      const created = await reference.createMissingDoc();
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
