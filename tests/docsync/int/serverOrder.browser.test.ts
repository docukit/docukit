import { describe, test } from "vitest";
import { commitEdits, testWrapper } from "./utils.js";

/** Every client has the empty document, stored and synced. */
const loadAll = async ({
  reference,
  otherTab,
  otherDevice,
}: Parameters<Parameters<typeof testWrapper>[0]>[0]) => {
  await reference.loadDoc();
  await otherDevice.loadDoc();
  await otherTab.loadDoc();
  for (const client of [reference, otherTab, otherDevice]) {
    client.doc?.forceCommit();
    await client.assertIDBDoc({ doc: [], ops: [] });
  }
};

/**
 * Appending a child puts it after the last one the replica has, so where it
 * lands depends on the order the replica applied the operations in.
 */
describe("Every replica follows the server's order", () => {
  test("an offline tab takes what its sibling synced", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherTab, otherDevice } = clients;
      await loadAll(clients);
      otherTab.disconnect();
      reference.disconnect();

      // The offline tab gets the sibling's edit over BroadcastChannel first.
      commitEdits(reference, ["Local"]);
      await otherTab.assertMemoryDoc(["Local"]);
      commitEdits(otherDevice, ["Remote"]);
      await otherDevice.assertIDBDoc({ doc: ["Remote"], ops: [] });

      // The server puts "Remote" first.
      reference.connect();
      const all = ["Remote", "Local"];
      await reference.assertMemoryDoc(all);
      await otherDevice.assertMemoryDoc(all);
      await otherTab.assertMemoryDoc(all);

      otherTab.connect();
      commitEdits(otherTab, ["Tab"]);
      for (const client of [reference, otherTab, otherDevice])
        await client.assertMemoryDoc([...all, "Tab"]);
    });
  });

  test("two tabs that edit at once end in the order IndexedDB keeps", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherTab, otherDevice } = clients;
      await loadAll(clients);
      otherTab.disconnect();
      reference.disconnect();

      // Each tab applies its own edit first and its sibling's after it. The
      // sibling's batch reaches IndexedDB first, so the server puts it first.
      commitEdits(otherTab, ["Tab"]);
      commitEdits(reference, ["Local"]);
      await reference.assertMemoryDoc(["Local", "Tab"]);
      await reference.assertIDBDoc({ doc: [], ops: ["Tab", "Local"] });

      reference.connect();
      const all = ["Tab", "Local"];
      await otherDevice.assertMemoryDoc(all);
      await reference.assertMemoryDoc(all);
      await otherTab.assertMemoryDoc(all);
    });
  });

  test("an edit made while a sync is in flight lands after the server's operations", async () => {
    await testWrapper(async (clients) => {
      const { reference, otherDevice } = clients;
      await loadAll(clients);

      // The other device's sync makes this one sync, with nothing to send.
      const slowSync = reference.holdNextSyncRequest();
      try {
        commitEdits(otherDevice, ["Remote"]);
        await slowSync.captured;
        // The user types while that request is in the air.
        commitEdits(reference, ["Local"]);
      } finally {
        slowSync.restore();
      }

      const all = ["Remote", "Local"];
      await otherDevice.assertMemoryDoc(all);
      await reference.assertMemoryDoc(all);
    });
  });
});
