import { describe, expect, test } from "vitest";
import {
  expectLiveDocsToMatchServer,
  prependChild,
} from "./convergenceUtils.js";
import {
  ChildNode,
  commitEdits,
  readStoredCopy,
  testWrapper,
} from "./utils.js";

type Clients = Parameters<Parameters<typeof testWrapper>[0]>[0];
type Device = Clients["reference"];

const syncFast = (devices: Device[]) => {
  for (const device of devices) {
    device.client["_collabMaxDebounce"] = 0;
    device.client["_singleClientMaxDebounce"] = 0;
  }
};

/** Server batches stored on top of the snapshot, not folded into it yet. */
const storedServerBatches = async (device: Device, docId: string) =>
  (await readStoredCopy(device.client, docId)).serverBatches;

/** Loads the doc on every device and waits until all subscriptions settled. */
const loadAll = async (devices: Device[]) => {
  for (const device of devices) await device.loadDoc();
  await expect
    .poll(() =>
      devices.every((device) => device.client["_syncQueue"].size === 0),
    )
    .toBe(true);
};

describe("Server batches stored on top of the snapshot", () => {
  test("a pushed batch is appended to storage, the snapshot is not rewritten", async () => {
    await testWrapper(async ({ docId, reference, otherDevice }) => {
      syncFast([reference, otherDevice]);
      await loadAll([reference, otherDevice]);

      commitEdits(otherDevice, ["A", "B"]);
      await reference.assertIDBDoc({ doc: ["A", "B"], ops: [] });
      await reference.assertMemoryDoc(["A", "B"]);
      expect(await storedServerBatches(reference, docId)).toBe(2);
      // The sender stores its own acknowledged batches the same way.
      await otherDevice.assertIDBDoc({ doc: ["A", "B"], ops: [] });
      expect(await storedServerBatches(otherDevice, docId)).toBe(2);
    });
  });

  test("a reload reads the snapshot and the batches not folded yet, and the next subscription folds them", async () => {
    await testWrapper(async (clients) => {
      const { docId, reference, otherDevice } = clients;
      syncFast([reference, otherDevice]);
      await loadAll([reference, otherDevice]);
      commitEdits(otherDevice, ["A", "B"]);
      await reference.assertIDBDoc({ doc: ["A", "B"], ops: [] });

      reference.disconnect();
      reference.unLoadDoc();
      await reference.loadDoc();
      await reference.assertMemoryDoc(["A", "B"]);
      commitEdits(reference, ["offline"]);
      await reference.assertIDBDoc({ doc: ["A", "B"], ops: ["offline"] });
      expect(await storedServerBatches(reference, docId)).toBe(2);

      reference.connect();
      await reference.assertIDBDoc({ doc: ["A", "B", "offline"], ops: [] });
      expect(await storedServerBatches(reference, docId)).toBe(0);
      await expectLiveDocsToMatchServer(clients, [reference, otherDevice]);
    });
  });

  test("tabs sharing storage fold the batches while both keep appending", async () => {
    await testWrapper(async (clients) => {
      const { docId, reference, otherTab, otherDevice } = clients;
      const devices = [reference, otherTab, otherDevice];
      syncFast(devices);
      for (const tab of [reference, otherTab]) {
        tab.client["_serverBatchesToCompact"] = 3;
      }
      await loadAll(devices);

      for (let i = 0; i < 12; i++) {
        prependChild(otherDevice, `device ${i}`);
        prependChild(i % 2 === 0 ? reference : otherTab, `tab ${i}`);
        await new Promise((resolve) => setTimeout(resolve, i % 3));
      }

      await expectLiveDocsToMatchServer(clients, devices);
      // What a reload would show is what the tabs show.
      const reloaded = (await readStoredCopy(reference.client, docId)).stored;
      const texts = (doc: typeof reference.doc) => {
        const values: string[] = [];
        doc?.root.children().forEach((node) => {
          if (node.is(ChildNode)) values.push(node.state.value.get());
        });
        return values;
      };
      expect(texts(reloaded?.doc)).toHaveLength(24);
      expect(texts(reloaded?.doc)).toStrictEqual(texts(reference.doc));
      expect(await storedServerBatches(reference, docId)).toBeLessThan(3);
    });
  });

  test("a device offline with batches not folded yet catches up and converges", async () => {
    await testWrapper(async (clients) => {
      const { docId, reference, otherDevice } = clients;
      syncFast([reference, otherDevice]);
      await loadAll([reference, otherDevice]);
      commitEdits(otherDevice, ["A"]);
      await reference.assertIDBDoc({ doc: ["A"], ops: [] });
      expect(await storedServerBatches(reference, docId)).toBe(1);

      reference.disconnect();
      commitEdits(otherDevice, ["B", "C"]);
      prependChild(reference, "offline");
      await otherDevice.assertIDBDoc({ doc: ["A", "B", "C"], ops: [] });

      reference.connect();
      await expectLiveDocsToMatchServer(clients, [reference, otherDevice]);
      await reference.assertIDBDoc({
        doc: ["offline", "A", "B", "C"],
        ops: [],
      });
      expect(await storedServerBatches(reference, docId)).toBe(0);
    });
  });
});
