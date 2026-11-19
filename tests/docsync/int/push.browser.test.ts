import { describe, expect, test } from "vitest";
import {
  expectLiveDocsToMatchServer,
  prependChild,
} from "./convergenceUtils.js";
import { startOwnServer } from "./serverCommands.js";
import { ChildNode, testWrapper } from "./utils.js";

type Clients = Parameters<Parameters<typeof testWrapper>[0]>[0];
type Device = Clients["reference"];

const tick = (ms = 3) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every event the server sends to this device, with its arguments. */
const recordPushes = (device: Device) => {
  const received: unknown[][] = [];
  device.client["_socket"].onAny((event: string, ...args: unknown[]) => {
    if (event === "operations") received.push(args);
  });
  return received;
};

const sentSyncs = (device: Device) =>
  device.reqSpy.mock.calls
    .filter(([event]) => event === "sync")
    .map(([, payload]) => payload);

const texts = (device: Device) => {
  const values: string[] = [];
  device.doc?.root.children().forEach((node) => {
    if (node.is(ChildNode)) values.push(node.state.value.get());
  });
  return values;
};

const syncFast = (devices: Device[]) => {
  for (const device of devices) {
    device.client["_collabMaxDebounce"] = 0;
    device.client["_singleClientMaxDebounce"] = 0;
  }
};

describe("Ordered push", () => {
  test("a saved batch reaches the other devices without a clock, and the sender only gets its clock", async () => {
    await testWrapper(async ({ docId, reference, otherTab, otherDevice }) => {
      await reference.loadDoc();
      await otherTab.loadDoc();
      await otherDevice.loadDoc();
      await reference.assertIDBDoc({ doc: [], ops: [] });
      // Tabs share their pending operations: a tab still subscribing would
      // send the edit below too.
      await expect
        .poll(() =>
          [reference, otherTab, otherDevice].every(
            (device) => device.client["_syncQueue"].size === 0,
          ),
        )
        .toBe(true);
      const toOtherDevice = recordPushes(otherDevice);
      const toOtherTab = recordPushes(otherTab);
      const syncsBefore = sentSyncs(reference).length;

      prependChild(reference, "Hello");
      await otherDevice.assertMemoryDoc(["Hello"]);
      await otherDevice.assertIDBDoc({ doc: ["Hello"], ops: [] });

      // Subscribed already: the request carries only the operations.
      const syncs = sentSyncs(reference).slice(syncsBefore);
      expect(syncs.map((payload) => Object.keys(payload).sort())).toStrictEqual(
        [["docId", "operations"]],
      );
      // Another device gets the document and the operations, nothing else.
      expect(toOtherDevice).toHaveLength(1);
      expect(toOtherDevice[0]?.[0]).toBe(docId);
      expect(toOtherDevice[0]).toHaveLength(2);
      // The sender's other tab already has them: it only learns their place.
      await expect.poll(() => toOtherTab).toStrictEqual([[docId]]);
      await otherTab.assertMemoryDoc(["Hello"]);
    });
  });

  test("a tab that is offline shows the batches another tab of its device stored", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherTab, otherDevice } = clients;
      const devices = [reference, otherTab, otherDevice];
      for (const device of devices) await device.loadDoc();
      await expect
        .poll(() =>
          devices.every((device) => device.client["_syncQueue"].size === 0),
        )
        .toBe(true);
      // An offline tab receives no pushes, only what its sibling stores.
      otherTab.disconnect();

      // Stored from a push.
      prependChild(otherDevice, "Pushed");
      await reference.assertIDBDoc({ doc: ["Pushed"], ops: [] });
      await otherTab.assertMemoryDoc(["Pushed"]);

      // Stored from the response to a subscription.
      reference.disconnect();
      prependChild(otherDevice, "Missed");
      await otherDevice.assertIDBDoc({ doc: ["Missed", "Pushed"], ops: [] });
      reference.connect();
      await reference.assertIDBDoc({ doc: ["Missed", "Pushed"], ops: [] });
      await otherTab.assertMemoryDoc(["Missed", "Pushed"]);
    });
  });

  test("three devices typing at the same time end with the server's document", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherDevice } = clients;
      const thirdDevice = await clients.addNewDevice();
      const devices = [reference, otherDevice, thirdDevice];
      for (const device of devices) await device.loadDoc();
      syncFast(devices);

      for (let round = 0; round < 6; round++) {
        devices.forEach((device, index) => {
          prependChild(device, `${index}:${round}`);
        });
        await tick(round % 3);
      }

      await expectLiveDocsToMatchServer(clients, devices);
    });
  });

  test("a push that arrives while the device's own request is on its way goes before it", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherDevice } = clients;
      await reference.loadDoc();
      await otherDevice.loadDoc();
      await reference.assertIDBDoc({ doc: [], ops: [] });
      syncFast([reference, otherDevice]);

      const slowRequest = reference.holdNextSyncRequest();
      try {
        prependChild(reference, "Local");
        await slowRequest.captured;
        // The server saves this first, so it pushes it before it answers.
        prependChild(otherDevice, "Remote");
        await reference.assertIDBDoc({ doc: ["Remote"], ops: ["Local"] });
        // Rebased: the local edit goes on top of the remote one, as the server
        // will apply it. Applying the push on top would give the reverse.
        await reference.assertMemoryDoc(["Remote", "Local"]);
        slowRequest.release();
      } finally {
        slowRequest.restore();
      }

      await expectLiveDocsToMatchServer(clients, [reference, otherDevice]);
      await reference.assertIDBDoc({ doc: ["Remote", "Local"], ops: [] });
      await otherDevice.assertMemoryDoc(["Remote", "Local"]);
      reference.doc?.undoManager.undo();
      await reference.assertMemoryDoc(["Remote"]);
    });
  });

  test("a device back from offline catches up from its clock and keeps its own edits", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherDevice } = clients;
      await reference.loadDoc();
      await otherDevice.loadDoc();
      syncFast([reference, otherDevice]);
      prependChild(reference, "Before");
      await otherDevice.assertIDBDoc({ doc: ["Before"], ops: [] });

      otherDevice.disconnect();
      prependChild(reference, "Online 1");
      prependChild(reference, "Online 2");
      prependChild(otherDevice, "Offline");
      await reference.assertIDBDoc({
        doc: ["Online 2", "Online 1", "Before"],
        ops: [],
      });
      await otherDevice.assertIDBDoc({ doc: ["Before"], ops: ["Offline"] });
      const clockWhileOffline = await otherDevice.storedClock();
      const syncsBefore = sentSyncs(otherDevice).length;

      otherDevice.connect();
      await expectLiveDocsToMatchServer(clients, [reference, otherDevice]);
      expect(texts(otherDevice).sort()).toStrictEqual([
        "Before",
        "Offline",
        "Online 1",
        "Online 2",
      ]);
      // The reconnect subscribes again from the stored clock, without the doc.
      const [subscription] = sentSyncs(otherDevice).slice(syncsBefore);
      expect(subscription).toMatchObject({ clock: clockWhileOffline });
    });
  });

  test("devices keep converging after the server restarts on the same storage", async () => {
    const server = await startOwnServer();
    try {
      await testWrapper(
        async (clients) => {
          const { reference, otherDevice } = clients;
          await reference.loadDoc();
          await otherDevice.loadDoc();
          syncFast([reference, otherDevice]);
          prependChild(reference, "Before restart");
          await otherDevice.assertIDBDoc({ doc: ["Before restart"], ops: [] });

          await server.restart();
          // Edits made while the connection is down wait in IndexedDB.
          prependChild(reference, "During restart");
          for (const device of [reference, otherDevice]) {
            device.disconnect();
            device.connect();
          }
          prependChild(otherDevice, "After restart");

          await expectLiveDocsToMatchServer(clients, [reference, otherDevice]);
          expect(texts(otherDevice).sort()).toStrictEqual([
            "After restart",
            "Before restart",
            "During restart",
          ]);
        },
        { port: server.port },
      );
    } finally {
      await server.stop();
    }
  });
});
