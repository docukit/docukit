import { expect, test } from "vitest";
import { testWrapper } from "./utils.js";
import { createCore } from "./coreUtils.js";

test("a direct core subscription receives remote edits and catches up after reconnecting", async () => {
  await testWrapper(async ({ docId, reference, otherDevice }) => {
    await reference.loadDoc();
    await otherDevice.loadDoc();
    await expect
      .poll(
        () =>
          reference.client["_docsCache"].get(docId)?.queryResult.fetchStatus,
      )
      .toBe("idle");
    reference.disconnect();
    reference.unLoadDoc();
    const { identity } = await reference.client["_localPromise"];
    const core = await createCore(identity.userId);
    let fetchStatus = "pending";
    let networkChanges = 0;
    core.on("change", ({ origin }) => {
      if (origin === "network") networkChanges += 1;
    });
    const release = core.subscribeDoc({ type: "test", id: docId }, (result) => {
      fetchStatus = result.fetchStatus;
    });
    try {
      await expect.poll(() => fetchStatus).toBe("idle");
      otherDevice.addChild("live edit");
      await expect.poll(() => networkChanges).toBeGreaterThan(0);
      await reference.assertIDBDoc({ doc: ["live edit"], ops: [] });

      core.disconnect();
      expect(fetchStatus).toBe("paused");
      otherDevice.addChild("while disconnected");
      await otherDevice.assertIDBDoc({
        doc: ["live edit", "while disconnected"],
        ops: [],
      });
      core.connect();
      await expect.poll(() => fetchStatus).toBe("idle");
      await reference.assertIDBDoc({
        doc: ["live edit", "while disconnected"],
        ops: [],
      });
    } finally {
      release();
      core.disconnect();
    }
  });
});

test("a failed initial callback releases its subscription and a new subscriber can load", async () => {
  await testWrapper(async ({ docId, reference }) => {
    await reference.loadDoc();
    const { identity } = await reference.client["_localPromise"];
    const core = await createCore(identity.userId);
    const failure = new Error("subscriber failed");
    try {
      expect(() =>
        core.subscribeDoc({ type: "test", id: docId }, () => {
          throw failure;
        }),
      ).toThrow(failure);
      let fetchStatus = "pending";
      const release = core.subscribeDoc(
        { type: "test", id: docId },
        (result) => {
          fetchStatus = result.fetchStatus;
        },
      );
      try {
        await expect.poll(() => fetchStatus).toBe("idle");
        expect(core["_docsCache"].get(docId)?.refCount).toBe(1);
      } finally {
        release();
      }
      await expect.poll(() => core["_docsCache"].has(docId)).toBe(false);
      // An unknown binding type also rejects the local load. Releasing the
      // failed callback must handle that rejection and remove the entry.
      const invalidId = crypto.randomUUID();
      expect(() =>
        core.subscribeDoc(
          { type: "unregistered", id: invalidId, createIfMissing: true },
          () => {
            throw failure;
          },
        ),
      ).toThrow(failure);
      await expect.poll(() => core["_docsCache"].has(invalidId)).toBe(false);
    } finally {
      core.disconnect();
    }
  });
});

test("subscriptions with the same callback have independent, repeatable releases", async () => {
  await testWrapper(async ({ docId, reference }) => {
    await reference.loadDoc();
    const { identity } = await reference.client["_localPromise"];
    const core = await createCore(identity.userId);
    let notifications = 0;
    let fetchStatus = "pending";
    const callback = () => {
      notifications += 1;
    };
    const releaseFirst = core.subscribeDoc(
      { type: "test", id: docId },
      callback,
    );
    const releaseSecond = core.subscribeDoc(
      { type: "test", id: docId },
      callback,
    );
    const releaseState = core.subscribeDoc(
      { type: "test", id: docId },
      (result) => {
        fetchStatus = result.fetchStatus;
      },
    );
    try {
      await expect.poll(() => fetchStatus).toBe("idle");
      releaseFirst();
      releaseFirst();
      expect(core["_docsCache"].get(docId)?.refCount).toBe(2);
      const before = notifications;
      core.disconnect();
      expect(fetchStatus).toBe("paused");
      expect(notifications).toBe(before + 1);
    } finally {
      releaseFirst();
      releaseSecond();
      releaseState();
      core.disconnect();
    }
  });
});
