import type { LegacyOperations } from "@docukit/docnode/compat";
import { expect, test } from "vitest";
import {
  commitEdits,
  saveLegacyPendingOperations,
  testWrapper,
} from "./utils.js";

/** A child "legacy" appended to the root, as `@docukit/docnode` 0.4 wrote it. */
const appendLegacyChild: LegacyOperations = [
  [[0, [["Kp3_a0Zx.1", "child"]], 0, 0, 0]],
  { "Kp3_a0Zx.1": { value: '"legacy"' } },
];

test("syncs operations that docnode 0.4 left pending in IndexedDB", async () => {
  await testWrapper(async ({ docId, reference, otherDevice, addNewDevice }) => {
    await reference.loadDoc();
    commitEdits(reference, ["first"]);
    await reference.assertIDBDoc({ doc: ["first"], ops: [] });
    reference.unLoadDoc();
    await expect
      .poll(() => reference.client["_docsCache"].has(docId))
      .toBe(false);

    // The app is updated with this edit still pending.
    reference.disconnect();
    await saveLegacyPendingOperations(reference, docId, [appendLegacyChild]);
    await otherDevice.loadDoc();
    await otherDevice.assertMemoryDoc(["first"]);

    reference.connect();
    await reference.loadDoc();
    await reference.assertMemoryDoc(["first", "legacy"]);
    await otherDevice.assertMemoryDoc(["first", "legacy"]);
    await reference.assertIDBDoc({ doc: ["first", "legacy"], ops: [] });

    const newDevice = await addNewDevice();
    await newDevice.loadDoc({ createIfMissing: false });
    await newDevice.assertMemoryDoc(["first", "legacy"]);
  });
});
