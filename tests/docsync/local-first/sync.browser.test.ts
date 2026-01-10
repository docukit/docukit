import { describe, test, expect, beforeAll, afterEach } from "vitest";
import {
  createClient,
  generateUserId,
  generateDocId,
  getDocWithCleanup,
  tick,
} from "./utils.js";

describe("Local-First Sync", () => {
  // Track clients created in each test for cleanup
  const activeClients: Array<ReturnType<typeof createClient>["client"]> = [];
  const activeCleanups: Array<() => void> = [];

  // Helper to create client and auto-track for cleanup
  const createTrackedClient = (userId?: string, token?: string) => {
    const result = createClient(userId, token);
    activeClients.push(result.client);
    return result;
  };

  // Helper to get doc and auto-track cleanup
  const getTrackedDoc = async (
    client: ReturnType<typeof createClient>["client"],
    args: { type: string; id: string; createIfMissing?: boolean },
  ) => {
    const { doc, cleanup } = await getDocWithCleanup(client, args);
    activeCleanups.push(cleanup);
    return doc;
  };

  beforeAll(async () => {
    await tick();
  });

  afterEach(async () => {
    // Clean up all docs
    for (const cleanup of activeCleanups) {
      cleanup();
    }
    activeCleanups.length = 0;

    // Close all client connections
    for (const client of activeClients) {
      // Close socket if exists
      if (client["_serverSync"]) {
        const socket = client["_serverSync"]["_api"]["_socket"];
        socket?.connected && socket.disconnect();
      }
      // Close broadcast channel if exists
      if (client["_broadcastChannel"]) {
        client["_broadcastChannel"].close();
      }
    }
    activeClients.length = 0;

    await tick(); // Give time for cleanup to complete
  });

  describe("Authentication", () => {
    test("client with valid token connects successfully", async () => {
      const { client } = createTrackedClient();
      const docId = generateDocId();

      const doc = await getTrackedDoc(client, {
        type: "test",
        id: docId,
        createIfMissing: true,
      });

      expect(doc).toBeDefined();
      expect(doc.root).toBeDefined();
    });

    test.todo("client with invalid token is rejected");

    test("multiple clients with different userIds authenticate independently", async () => {
      const userId1 = generateUserId();
      const userId2 = generateUserId();

      const { client: client1 } = createTrackedClient(userId1);
      const { client: client2 } = createTrackedClient(userId2);

      const docId1 = generateDocId();
      const docId2 = generateDocId();

      // Both should be able to create docs independently
      const [doc1, doc2] = await Promise.all([
        getTrackedDoc(client1, {
          type: "test",
          id: docId1,
          createIfMissing: true,
        }),
        getTrackedDoc(client2, {
          type: "test",
          id: docId2,
          createIfMissing: true,
        }),
      ]);

      expect(doc1).toBeDefined();
      expect(doc2).toBeDefined();
    });
  });
});
