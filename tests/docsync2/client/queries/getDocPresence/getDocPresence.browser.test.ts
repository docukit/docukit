import { describe, expect, test } from "vitest";
import { createTestClient, type TestClient } from "../../utils/client.js";
import { reconnectTestClient } from "../../utils/connection.js";
import {
  createTestDoc,
  observeDoc,
  waitForDocStatus,
} from "../../utils/doc.js";
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
  test("starts with empty presence", () => {
    const testClient = createTestClient();
    const observedPresence = observePresence(testClient, testClient.docArgs.id);

    try {
      const result = observedPresence.observer.getCurrentResult();

      expect(result.fetchStatus).toBe("idle");
      expect(result.data).toStrictEqual({});
    } finally {
      observedPresence.unsubscribe();
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
        (result) => result.data?.[peerClientId] !== undefined,
      );

      expect(result.data?.[peerClientId]).toStrictEqual({ cursor: "peer" });
      expect(
        peerPresence.observer.getCurrentResult().data?.[peerClientId],
      ).toBeUndefined();
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
        (result) => result.data?.[peerClientId] !== undefined,
      );

      const removedPresence = waitForNextPresenceResult(
        referencePresence,
        (result) =>
          result.data !== added.data &&
          result.data?.[peerClientId] === undefined,
      );
      await peer.docSync.mutations.setDocPresence({
        docId: reference.docArgs.id,
        presence: null,
      });
      const removed = await removedPresence;

      expect(removed.data).toStrictEqual({});
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
        (result) => result.data?.[peerClientId] !== undefined,
      );

      const removedPresence = waitForNextPresenceResult(
        referencePresence,
        (result) =>
          result.data !== added.data &&
          result.data?.[peerClientId] === undefined,
      );
      peer.docSync.disconnect();
      const removed = await removedPresence;

      expect(removed.data).toStrictEqual({});
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
        name: "AuthorizationError",
        message: "Access denied",
      });
    } finally {
      observedDoc.unsubscribe();
      cleanupClient(testClient);
    }
  });
});
