import { expect, test } from "vitest";
import { seedMetadata } from "../metadataUtils.js";
import { testWrapper } from "./utils.js";
import { runWorkerClient } from "./workerUtils.js";

test("the shared core uploads offline edits from a worker and notifies another device", async () => {
  await testWrapper(async ({ docId, reference, otherDevice }) => {
    await reference.loadDoc();
    await otherDevice.loadDoc();
    await expect.poll(() => reference.client["_syncQueue"].size).toBe(0);
    reference.disconnect();
    reference.addChild("from shared worker core");
    reference.doc?.forceCommit();
    await reference.client.flush(docId);
    reference.unLoadDoc();
    const { identity } = await reference.client["_localPromise"];
    // The fixture simulates several installations in one page; select this one.
    await seedMetadata(identity.userId, crypto.randomUUID());
    await expect(
      runWorkerClient({ token: `test-token-${identity.userId}`, docId }),
    ).resolves.toMatchObject({
      status: "success",
      docId,
      hasWindow: false,
      hasLocalStorage: false,
    });
    await reference.assertIDBDoc({ doc: ["from shared worker core"], ops: [] });
    await otherDevice.assertMemoryDoc(["from shared worker core"]);
  });
});

test("a worker loads the same local document and identity while offline", async () => {
  await testWrapper(async ({ docId, reference }) => {
    await reference.loadDoc();
    await expect.poll(() => reference.client["_syncQueue"].size).toBe(0);
    const { identity } = await reference.client["_localPromise"];
    await seedMetadata(identity.userId, crypto.randomUUID());
    await expect(
      runWorkerClient({ token: "unused-offline-token", docId, offline: true }),
    ).resolves.toMatchObject({
      status: "success",
      docId,
      hasWindow: false,
      hasLocalStorage: false,
    });
  });
});

test("worker edits persist and sync without an animation frame API", async () => {
  await testWrapper(async ({ docId, reference, otherDevice }) => {
    await reference.loadDoc();
    await otherDevice.loadDoc();
    await expect.poll(() => reference.client["_syncQueue"].size).toBe(0);
    reference.disconnect();
    reference.unLoadDoc();
    const { identity } = await reference.client["_localPromise"];
    await seedMetadata(identity.userId, crypto.randomUUID());
    await expect(
      runWorkerClient({
        token: `test-token-${identity.userId}`,
        docId,
        edit: "edited inside worker",
      }),
    ).resolves.toMatchObject({ status: "success", docId });
    await reference.assertIDBDoc({ doc: ["edited inside worker"], ops: [] });
    await otherDevice.assertMemoryDoc(["edited inside worker"]);
  });
});
