/// <reference types="vite/client" />
import { afterAll, expect, test } from "vitest";
import { seedMetadata } from "../metadataUtils.js";
import { testWrapper } from "./utils.js";
import {
  measureWorker,
  summarizeMeasurements,
  type ComparisonResult,
} from "./comparisonUtils.js";

// Opt in: VITE_DOCSYNC_BENCHMARK=1 pnpm test:once tests/docsync/int/comparison.browser.test.ts
// Two warmups followed by ten fresh workers, identities and one-document stores.
// Vite serves development modules: entry timing is not a production bundle benchmark.
const enabled = import.meta.env.VITE_DOCSYNC_BENCHMARK === "1";
const results: ComparisonResult[] = [];

test.skipIf(!enabled).each(Array.from({ length: 12 }, (_, i) => i))(
  "worker comparison sample %i",
  async (sample) => {
    await testWrapper(async ({ docId, reference, otherTab, otherDevice }) => {
      otherTab.disconnect();
      await reference.loadDoc();
      await otherDevice.loadDoc();
      await expect.poll(() => reference.client["_syncQueue"].size).toBe(0);
      reference.disconnect();
      reference.unLoadDoc();
      const { identity } = await reference.client["_localPromise"];
      await seedMetadata(identity.userId, crypto.randomUUID());
      const result = await measureWorker(
        `test-token-${identity.userId}`,
        docId,
      );
      // Completion must mean that the actual edit reached both storage and another device.
      await reference.assertIDBDoc({ doc: ["benchmark edit"], ops: [] });
      await otherDevice.assertMemoryDoc(["benchmark edit"]);
      expect(result.syncRequests).toBe(1);
      expect(result.syncReadyMs).toBeGreaterThan(result.localReadyMs);
      expect(result.localReadyMs).toBeGreaterThan(result.workerEntryMs);
      if (sample >= 2) results.push(result);
    });
  },
);

afterAll(() => {
  if (!enabled) return;
  console.log(
    "DOCSYNC_COMPARISON",
    JSON.stringify({
      samples: results.length,
      workerEntryMs: summarizeMeasurements(results.map((r) => r.workerEntryMs)),
      localReadyMs: summarizeMeasurements(results.map((r) => r.localReadyMs)),
      syncReadyMs: summarizeMeasurements(results.map((r) => r.syncReadyMs)),
      syncRequests: results.map((r) => r.syncRequests),
      raw: results,
    }),
  );
});
