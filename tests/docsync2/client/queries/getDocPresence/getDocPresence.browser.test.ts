import { describe, expect, test } from "vitest";
import { tick } from "../../utils/async.js";
import { createTestClient, type TestClient } from "../../utils/client.js";
import {
  disconnectTestClient,
  reconnectTestClient,
} from "../../utils/connection.js";
import {
  createTestDoc,
  observeDoc,
  waitForDocStatus,
} from "../../utils/doc.js";
import { generateTestUserId } from "../../utils/generators.js";
import {
  observePresence,
  waitForNextPresenceResult,
  waitForObservedPresenceResult,
} from "../../utils/presence.js";

const unauthorizedDocId = "01j00000000000000000000000";

const cleanupClient = (testClient: TestClient) => {
  testClient.docSync.disconnect();
  testClient.docSync.dispose();
};

const observeSyncedDoc = async (
  testClient: TestClient,
  docArgs: TestClient["docArgs"],
) => {
  const observed = observeDoc(testClient, docArgs);
  await waitForDocStatus(testClient, observed, "idle");

  return observed;
};

describe("getDocPresence", () => {
  test("starts with empty presence", async () => {
    const testClient = createTestClient();
    const unsubscribes: (() => void)[] = [];

    try {
      await createTestDoc(testClient);
      unsubscribes.push(
        (await observeSyncedDoc(testClient, testClient.docArgs)).unsubscribe,
      );
      const observedPresence = observePresence(
        testClient,
        testClient.docArgs.id,
      );
      unsubscribes.push(observedPresence.unsubscribe);

      expect(observedPresence.getCurrentPresence()).toStrictEqual({});
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      cleanupClient(testClient);
    }
  });

  test("receives another active client's presence", async () => {
    const reference = createTestClient();
    const peer = createTestClient();
    const unsubscribes: (() => void)[] = [];

    try {
      await createTestDoc(reference);
      unsubscribes.push(
        (await observeSyncedDoc(reference, reference.docArgs)).unsubscribe,
      );
      unsubscribes.push(
        (await observeSyncedDoc(peer, reference.docArgs)).unsubscribe,
      );

      const referencePresence = observePresence(
        reference,
        reference.docArgs.id,
      );
      const peerPresence = observePresence(peer, reference.docArgs.id);
      unsubscribes.push(
        referencePresence.unsubscribe,
        peerPresence.unsubscribe,
      );

      await peer.docSync.mutations.setDocPresence({
        docId: reference.docArgs.id,
        presence: { cursor: "peer" },
      });

      const peerClientId = peer.docSync["_clientId"];
      const result = await waitForObservedPresenceResult(
        referencePresence,
        (presence) => presence[peerClientId] !== undefined,
      );

      expect(result[peerClientId]).toStrictEqual({ cursor: "peer" });
      expect(peerPresence.getCurrentPresence()[peerClientId]).toBeUndefined();
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      cleanupClient(reference);
      cleanupClient(peer);
    }
  });

  test("removes presence when a client sends null", async () => {
    const reference = createTestClient();
    const peer = createTestClient();
    const unsubscribes: (() => void)[] = [];

    try {
      await createTestDoc(reference);
      unsubscribes.push(
        (await observeSyncedDoc(reference, reference.docArgs)).unsubscribe,
      );
      unsubscribes.push(
        (await observeSyncedDoc(peer, reference.docArgs)).unsubscribe,
      );

      const referencePresence = observePresence(
        reference,
        reference.docArgs.id,
      );
      unsubscribes.push(referencePresence.unsubscribe);

      const peerClientId = peer.docSync["_clientId"];
      await peer.docSync.mutations.setDocPresence({
        docId: reference.docArgs.id,
        presence: { cursor: "peer" },
      });
      const added = await waitForObservedPresenceResult(
        referencePresence,
        (presence) => presence[peerClientId] !== undefined,
      );

      const removedPresence = waitForNextPresenceResult(
        referencePresence,
        (presence) =>
          presence !== added && presence[peerClientId] === undefined,
      );
      await peer.docSync.mutations.setDocPresence({
        docId: reference.docArgs.id,
        presence: null,
      });
      const removed = await removedPresence;

      expect(removed).toStrictEqual({});
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      cleanupClient(reference);
      cleanupClient(peer);
    }
  });

  test("removes presence when a client disconnects", async () => {
    const reference = createTestClient();
    const peer = createTestClient();
    const unsubscribes: (() => void)[] = [];

    try {
      await createTestDoc(reference);
      unsubscribes.push(
        (await observeSyncedDoc(reference, reference.docArgs)).unsubscribe,
      );
      unsubscribes.push(
        (await observeSyncedDoc(peer, reference.docArgs)).unsubscribe,
      );

      const referencePresence = observePresence(
        reference,
        reference.docArgs.id,
      );
      unsubscribes.push(referencePresence.unsubscribe);

      const peerClientId = peer.docSync["_clientId"];
      await peer.docSync.mutations.setDocPresence({
        docId: reference.docArgs.id,
        presence: { cursor: "peer" },
      });
      const added = await waitForObservedPresenceResult(
        referencePresence,
        (presence) => presence[peerClientId] !== undefined,
      );

      const removedPresence = waitForNextPresenceResult(
        referencePresence,
        (presence) =>
          presence !== added && presence[peerClientId] === undefined,
      );
      peer.docSync.disconnect();
      const removed = await removedPresence;

      expect(removed).toStrictEqual({});
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      cleanupClient(reference);
      cleanupClient(peer);
    }
  });

  test("clears cached presence when the doc is no longer observed", async () => {
    const reference = createTestClient();
    const peer = createTestClient();
    const unsubscribes: (() => void)[] = [];
    let referenceDoc: Awaited<ReturnType<typeof observeSyncedDoc>> | undefined;
    let referencePresence: ReturnType<typeof observePresence> | undefined;

    try {
      await createTestDoc(reference);
      referenceDoc = await observeSyncedDoc(reference, reference.docArgs);
      unsubscribes.push(
        (await observeSyncedDoc(peer, reference.docArgs)).unsubscribe,
      );

      referencePresence = observePresence(reference, reference.docArgs.id);

      await peer.docSync.mutations.setDocPresence({
        docId: reference.docArgs.id,
        presence: { cursor: "peer" },
      });
      const peerClientId = peer.docSync["_clientId"];
      await waitForObservedPresenceResult(
        referencePresence,
        (presence) => presence[peerClientId] !== undefined,
      );

      referencePresence.unsubscribe();
      referenceDoc.unsubscribe();
      await tick();

      expect(
        reference.docSync["_presenceStateByDocId"].has(reference.docArgs.id),
      ).toBe(false);
    } finally {
      referencePresence?.unsubscribe();
      referenceDoc?.unsubscribe();
      for (const unsubscribe of unsubscribes) unsubscribe();
      cleanupClient(reference);
      cleanupClient(peer);
    }
  });

  test("receives same-user presence through BroadcastChannel", async () => {
    const userId = generateTestUserId();
    const reference = createTestClient({
      timing: { collabMaxDebounce: 0 },
      userId,
    });
    const peer = createTestClient({ timing: { collabMaxDebounce: 0 }, userId });
    const unsubscribes: (() => void)[] = [];

    try {
      await createTestDoc(reference);
      unsubscribes.push(
        (await observeSyncedDoc(reference, reference.docArgs)).unsubscribe,
      );
      unsubscribes.push(
        (await observeSyncedDoc(peer, reference.docArgs)).unsubscribe,
      );

      const referencePresence = observePresence(
        reference,
        reference.docArgs.id,
      );
      unsubscribes.push(referencePresence.unsubscribe);
      await disconnectTestClient(reference);

      const peerClientId = peer.docSync["_clientId"];
      const receivedPresence = waitForObservedPresenceResult(
        referencePresence,
        (presence) => presence[peerClientId] !== undefined,
      );
      await peer.docSync.mutations.setDocPresence({
        docId: reference.docArgs.id,
        presence: { cursor: "broadcast" },
      });

      const result = await receivedPresence;
      expect(result[peerClientId]).toStrictEqual({ cursor: "broadcast" });
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      cleanupClient(reference);
      cleanupClient(peer);
    }
  });

  test("setDocPresence requires an active getDoc query", async () => {
    const testClient = createTestClient();

    try {
      await expect(
        testClient.docSync.mutations.setDocPresence({
          docId: testClient.docArgs.id,
          presence: { cursor: "peer" },
        }),
      ).rejects.toThrow(
        `Doc ${testClient.docArgs.id} is not loaded, cannot set presence`,
      );
    } finally {
      cleanupClient(testClient);
    }
  });

  test("setDocPresence propagates authorization errors", async () => {
    const testClient = createTestClient();
    const docArgs = { type: testClient.docArgs.type, id: unauthorizedDocId };
    const observedDoc = observeDoc(testClient, docArgs);

    try {
      await reconnectTestClient(testClient);

      await expect(
        testClient.docSync.mutations.setDocPresence({
          docId: unauthorizedDocId,
          presence: { cursor: "blocked" },
        }),
      ).rejects.toMatchObject({
        type: "AuthorizationError",
        message: "Access denied",
      });
    } finally {
      observedDoc.unsubscribe();
      cleanupClient(testClient);
    }
  });

  test("setDocPresence sends only the latest presence after collab debounce", async () => {
    const reference = createTestClient();
    const peer = createTestClient({ timing: { collabMaxDebounce: 30 } });
    const unsubscribes: (() => void)[] = [];

    try {
      await createTestDoc(reference);
      unsubscribes.push(
        (await observeSyncedDoc(reference, reference.docArgs)).unsubscribe,
      );
      unsubscribes.push(
        (await observeSyncedDoc(peer, reference.docArgs)).unsubscribe,
      );

      const referencePresence = observePresence(
        reference,
        reference.docArgs.id,
      );
      unsubscribes.push(referencePresence.unsubscribe);
      const peerClientId = peer.docSync["_clientId"];

      const firstPresence = peer.docSync.mutations.setDocPresence({
        docId: reference.docArgs.id,
        presence: { cursor: "first" },
      });
      const secondPresence = peer.docSync.mutations.setDocPresence({
        docId: reference.docArgs.id,
        presence: { cursor: "second" },
      });

      await tick(10);
      expect(
        referencePresence.getCurrentPresence()[peerClientId],
      ).toBeUndefined();

      await Promise.all([firstPresence, secondPresence]);
      const result = await waitForObservedPresenceResult(
        referencePresence,
        (presence) => presence[peerClientId] !== undefined,
      );

      expect(result[peerClientId]).toStrictEqual({ cursor: "second" });
      expect(
        referencePresence.results.some((presence) => {
          const peerPresence = presence[peerClientId];
          return (
            typeof peerPresence === "object" &&
            peerPresence !== null &&
            "cursor" in peerPresence &&
            peerPresence.cursor === "first"
          );
        }),
      ).toBe(false);
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      cleanupClient(reference);
      cleanupClient(peer);
    }
  });

  test("setDocPresence sends immediately when collab debounce is zero", async () => {
    const reference = createTestClient();
    const peer = createTestClient({ timing: { collabMaxDebounce: 0 } });
    const unsubscribes: (() => void)[] = [];

    try {
      await createTestDoc(reference);
      unsubscribes.push(
        (await observeSyncedDoc(reference, reference.docArgs)).unsubscribe,
      );
      unsubscribes.push(
        (await observeSyncedDoc(peer, reference.docArgs)).unsubscribe,
      );

      const referencePresence = observePresence(
        reference,
        reference.docArgs.id,
      );
      unsubscribes.push(referencePresence.unsubscribe);

      await peer.docSync.mutations.setDocPresence({
        docId: reference.docArgs.id,
        presence: { cursor: "immediate" },
      });

      const peerClientId = peer.docSync["_clientId"];
      const result = await waitForObservedPresenceResult(
        referencePresence,
        (presence) => presence[peerClientId] !== undefined,
      );

      expect(result[peerClientId]).toStrictEqual({ cursor: "immediate" });
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      cleanupClient(reference);
      cleanupClient(peer);
    }
  });
});
