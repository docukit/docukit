import { describe, expect, test, vi } from "vitest";
import {
  expectLiveDocsToMatchServer,
  prependChild,
  waitForOwnSubscription,
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

/**
 * Waits until each connected device subscribed and reconciled the response.
 * An edit made while its own subscription is on the wire can end up in a
 * different order than the server's (issue #97), which these tests are not
 * about.
 */
const waitForSubscriptions = async (clients: Clients, devices: Device[]) => {
  for (const device of devices) {
    await expect.poll(() => device.client["_socket"].connected).toBe(true);
    await waitForOwnSubscription(device, clients.docId);
  }
};

/**
 * Holds the tab's storage writes from now on, as a tab that is slow, or dead,
 * would. `release` runs them, in order; `abandon` never does, as for a tab
 * that died.
 */
const holdStorageWrites = async (device: Device) => {
  const { provider } = await device.client["_localPromise"];
  const transaction = provider.transaction.bind(provider);
  const held: (() => void)[] = [];
  const spy = vi
    .spyOn(provider, "transaction")
    .mockImplementation((mode, callback) => {
      if (mode !== "readwrite") return transaction(mode, callback);
      return new Promise((resolve, reject) => {
        held.push(() => {
          transaction(mode, callback).then(resolve, reject);
        });
      });
    });
  return {
    release: () => {
      spy.mockRestore();
      for (const write of held.splice(0)) write();
    },
    abandon: () => spy.mockRestore(),
  };
};

/** The tab keeps its edits in storage instead of sending them. */
const holdEdits = (device: Device) => {
  device.client["_collabMaxDebounce"] = 60_000;
  device.client["_singleClientMaxDebounce"] = 60_000;
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
      await waitForSubscriptions(clients, devices);

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
      await waitForSubscriptions(clients, [reference, otherDevice]);

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
      await waitForSubscriptions(clients, [reference, otherDevice]);
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
          await waitForSubscriptions(clients, [reference, otherDevice]);
          prependChild(reference, "Before restart");
          await otherDevice.assertIDBDoc({ doc: ["Before restart"], ops: [] });

          await server.restart();
          // Edits made while the connection is down wait in IndexedDB.
          prependChild(reference, "During restart");
          for (const device of [reference, otherDevice]) {
            device.disconnect();
            device.connect();
          }
          await waitForSubscriptions(clients, [otherDevice]);
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

  test("a tab stores later batches when the tab that sent the one before them died before storing it", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherTab, otherDevice } = clients;
      const devices = [reference, otherTab, otherDevice];
      syncFast(devices);
      otherTab.client["_storageGapTimeout"] = 20;
      for (const device of devices) await device.loadDoc();
      await expect
        .poll(() =>
          devices.every((device) => device.client["_syncQueue"].size === 0),
        )
        .toBe(true);

      // The reference tab sends its batch, and dies once it is on the wire:
      // nothing it writes to storage from then on lands.
      const held = reference.holdNextSyncRequest();
      prependChild(reference, "Hello");
      await held.captured;
      const { provider } = await reference.client["_localPromise"];
      const transaction = provider.transaction.bind(provider);
      const dead = vi
        .spyOn(provider, "transaction")
        .mockImplementation((mode, callback) =>
          mode === "readwrite"
            ? new Promise(() => undefined)
            : transaction(mode, callback),
        );
      held.release();
      // The server saved it: another device received it.
      await otherDevice.assertMemoryDoc(["Hello"]);
      await otherTab.assertMemoryDoc(["Hello"]);

      prependChild(otherDevice, "World");
      await otherTab.assertMemoryDoc(["World", "Hello"]);
      await otherTab.assertIDBDoc({ doc: ["World", "Hello"], ops: [] });
      dead.mockRestore();
      held.restore();
    });
  });

  test("a batch pushed while the sibling tab has yet to store the one before goes under this tab's own edits", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherTab, otherDevice } = clients;
      const devices = [reference, otherTab, otherDevice];
      for (const device of devices) await device.loadDoc();
      syncFast([reference, otherDevice]);
      holdEdits(otherTab);
      await waitForSubscriptions(clients, devices);

      // The reference tab sends its batch and is slow to store it.
      const held = reference.holdNextSyncRequest();
      prependChild(reference, "Sibling");
      await held.captured;
      const slowStorage = await holdStorageWrites(reference);
      held.release();
      await otherDevice.assertMemoryDoc(["Sibling"]);
      await otherTab.assertMemoryDoc(["Sibling"]);

      // The other tab edits, and keeps the edit to itself for now.
      prependChild(otherTab, "Own");
      const toOtherTab = recordPushes(otherTab);
      prependChild(otherDevice, "Remote");
      await expect.poll(() => toOtherTab.length).toBe(1);
      // The server puts "Remote" before "Own", which it has yet to receive:
      // the tab cannot apply it on top. It waits for the storage.
      await otherTab.assertMemoryDoc(["Own", "Sibling"]);
      slowStorage.release();
      // Rebuilt from storage, with the tab's own edit applied after "Remote",
      // as the server will: "Own" goes right before "Sibling", where it was
      // inserted.
      await otherTab.assertMemoryDoc(["Remote", "Own", "Sibling"]);

      syncFast([otherTab]);
      void otherTab.client["_sync"](clients.docId);
      await expectLiveDocsToMatchServer(clients, devices);
    });
  });

  test("a tab that subscribes again while its own batch is on the wire keeps following the pushes", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherTab, otherDevice } = clients;
      const devices = [reference, otherTab, otherDevice];
      syncFast(devices);
      otherTab.client["_storageGapTimeout"] = 20;
      for (const device of devices) await device.loadDoc();
      await waitForSubscriptions(clients, devices);

      // The reference tab sends its batch and stops storing anything.
      const held = reference.holdNextSyncRequest();
      prependChild(reference, "Sibling");
      await held.captured;
      const deadStorage = await holdStorageWrites(reference);
      held.release();
      await otherDevice.assertMemoryDoc(["Sibling"]);

      // The other tab's own batch is on the wire when its storage gap times
      // out and it subscribes again.
      const ownRequest = otherTab.holdNextSyncRequest();
      prependChild(otherTab, "Own");
      await ownRequest.captured;
      prependChild(otherDevice, "Remote");
      await expect
        .poll(
          () =>
            otherTab.client["_docsCache"].get(clients.docId)?.stream
              ?.generation,
        )
        .toBe(-1);
      ownRequest.release();

      await waitForSubscriptions(clients, [otherTab]);
      prependChild(otherDevice, "After");
      await expect.poll(() => texts(otherTab)[0]).toBe("After");
      await expectLiveDocsToMatchServer(clients, [otherTab, otherDevice]);
      deadStorage.abandon();
      ownRequest.restore();
    });
  });

  test("another user signed in on the same device gets the operations of a batch", async () => {
    await testWrapper(async (clients) => {
      const deviceId = crypto.randomUUID();
      const alice = await clients.addNewDevice({ deviceId });
      const bob = await clients.addNewDevice({ deviceId });
      for (const device of [alice, bob]) await device.loadDoc();
      syncFast([alice, bob]);
      await waitForSubscriptions(clients, [alice, bob]);
      const toBob = recordPushes(bob);

      prependChild(alice, "Hello");
      // Bob's storage is his own: a bare notice would leave him without it.
      await bob.assertMemoryDoc(["Hello"]);
      await bob.assertIDBDoc({ doc: ["Hello"], ops: [] });
      expect(toBob[0]).toHaveLength(2);
    });
  });
});
