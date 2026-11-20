import { describe, expect, test, vi } from "vitest";
import {
  expectLiveDocsToMatchServer,
  prependChild,
  runRandomHistory,
} from "./convergenceUtils.js";
import { testWrapper } from "./utils.js";

/**
 * The server applies a client's operations after every operation it already
 * had. DocNode operations do not commute, so a live doc that applied remote
 * operations on top of its own unconfirmed edits would show a different
 * document than the one everyone else loads from the server.
 *
 * Races of a subscription in flight are tracked in issue #97 and left out
 * here (see `waitForOwnSubscription`).
 */
describe("Live docs converge with the server", () => {
  test("concurrent prepends made offline", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherDevice } = clients;
      await reference.loadDoc();
      await otherDevice.loadDoc();
      await otherDevice.assertIDBDoc({ doc: [], ops: [] });

      reference.disconnect();
      prependChild(reference, "X");
      prependChild(otherDevice, "Y");
      await otherDevice.assertIDBDoc({ doc: ["Y"], ops: [] });

      await expectLiveDocsToMatchServer(clients, [reference, otherDevice]);
    });
  });

  test("server operations saved locally reach the live doc when the connection drops", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherDevice } = clients;
      await reference.loadDoc();
      await otherDevice.loadDoc();
      await reference.assertIDBDoc({ doc: [], ops: [] });
      await expect.poll(() => reference.client["_syncQueue"].size).toBe(0);

      // Drop the connection right after the sync saved the server operations.
      const { provider } = await reference.client["_localPromise"];
      const transaction = provider.transaction.bind(provider);
      const spy = vi
        .spyOn(provider, "transaction")
        .mockImplementation(async (mode, callback) => {
          const result = await transaction(mode, callback);
          if (mode === "readwrite") {
            spy.mockRestore();
            reference.disconnect();
          }
          return result;
        });
      try {
        prependChild(otherDevice, "Remote");
        await reference.assertIDBDoc({ doc: ["Remote"], ops: [] });
        await reference.assertMemoryDoc(["Remote"]);
      } finally {
        spy.mockRestore();
      }

      await expectLiveDocsToMatchServer(clients, [reference, otherDevice]);
    });
  });

  test.each(Array.from({ length: 15 }, (_, seed) => seed + 1))(
    "random history %i",
    async (seed) => {
      await testWrapper((clients) => runRandomHistory(clients, seed));
    },
  );
});
