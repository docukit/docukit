import {
  DocSyncClient,
  IndexedDBProvider,
  type ClientConfig,
} from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import {
  defineNode,
  string,
  type Doc,
  type JsonDoc,
  type Operations,
  type DocNode,
} from "docnode";
import { ulid } from "ulid";
import { expect, vi, type Mock } from "vitest";
import type {
  DocSyncEventName,
  DocSyncEvents,
} from "../../../packages/docsync/dist/src/shared/types.js";

// ============================================================================
// Constants
// ============================================================================

// Extend globalThis to include test server port (set by globalSetup)
declare global {
  var __TEST_SERVER_PORT__: number | undefined;
}

/**
 * Get the test server URL with the dynamically assigned port.
 * The port is set by globalSetup.ts and stored in globalThis.
 */
const getTestServerUrl = (): string => {
  const port = globalThis.__TEST_SERVER_PORT__ ?? 8082;
  return `ws://localhost:${port}`;
};

// ============================================================================
// Node Definitions
// ============================================================================

const ChildNode = defineNode({
  type: "child",
  state: {
    value: string(""),
  },
});

// ============================================================================
// Doc Binding
// ============================================================================

const createDocBinding = () =>
  DocNodeBinding([{ type: "test", extensions: [{ nodes: [ChildNode] }] }]);

// ============================================================================
// Generators
// ============================================================================

let clientCounter = 0;
let testCounter = 0; // Add test counter for isolation

const generateUserId = () =>
  `integration-user-${Date.now()}-test${++testCounter}-${++clientCounter}`;

const generateDocId = () => ulid().toLowerCase();

// ============================================================================
// Token Helpers
// ============================================================================

/**
 * Creates a test token for authentication.
 * Token format: "test-token-{userId}"
 */
const createTestToken = (userId: string) => `test-token-${userId}`;

// ============================================================================
// Types
// ============================================================================

type ClientUtils = {
  client: DocSyncClient<Doc, JsonDoc, Operations>;
  doc: Doc | undefined;
  loadDoc: () => Promise<void>;
  unLoadDoc: () => void;
  addChild: (text: string) => void;
  assertIDBDoc: (expected?: {
    clock: number;
    doc: string[];
    ops: string[];
  }) => Promise<void>;
  assertMemoryDoc: (children?: string[]) => void;
  reqSpy: Mock<
    <E extends DocSyncEventName>(
      event: E,
      payload: DocSyncEvents<JsonDoc, Operations>[E]["request"],
    ) => Promise<DocSyncEvents<JsonDoc, Operations>[E]["response"]>
  >;
  waitSync: () => Promise<void>;
  disconnect: () => void;
  connect: () => void;
};

export type ClientsSetup = {
  docId: string;
  reference: ClientUtils;
  otherTab: ClientUtils;
  otherDevice: ClientUtils;
};

// ============================================================================
// Test Wrapper (Setup + Cleanup)
// ============================================================================

/**
 * Test wrapper that creates clients, runs the test callback, and cleans up.
 * This ensures cleanup always happens, even if the test fails.
 */
export const testWrapper = async (
  callback: (clients: ClientsSetup) => Promise<void>,
): Promise<void> => {
  const clients = await setupClients();

  try {
    await callback(clients);
  } finally {
    // Cleanup: unload docs
    clients.reference.unLoadDoc();
    clients.otherTab.unLoadDoc();
    clients.otherDevice.unLoadDoc();

    // Cleanup: close connections
    const allClients = [
      clients.reference.client,
      clients.otherTab.client,
      clients.otherDevice.client,
    ];

    for (const client of allClients) {
      // Close socket if exists
      const serverSync = client["_serverSync"];
      if (serverSync) {
        const socket = serverSync["_api"]["_socket"];
        if (socket?.connected) {
          socket.disconnect();
        }
      }
      // Close broadcast channel if exists
      const bc = client["_broadcastChannel"];
      if (bc) {
        bc.close();
      }
    }

    // Give time for cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

// ============================================================================
// Client Factory
// ============================================================================

/**
 * Creates a DocSyncClient with specific configuration.
 */
const createClientWithConfig = (config: {
  userId: string;
  token: string;
  docBinding: ReturnType<typeof createDocBinding>;
  local: boolean;
}): DocSyncClient<Doc, JsonDoc, Operations> => {
  const clientConfig: ClientConfig<Doc, JsonDoc, Operations> = {
    server: {
      url: getTestServerUrl(),
      auth: { getToken: async () => config.token },
    },
    docBinding: config.docBinding,
  };

  // Add local config only if enabled
  if (config.local) {
    clientConfig.local = {
      provider: IndexedDBProvider,
      getIdentity: async () => ({
        userId: config.userId,
        secret: "test-secret",
      }),
    };
  }

  return new DocSyncClient(clientConfig);
};

// ============================================================================
// Client Setup (Internal)
// ============================================================================

const setupClients = async (): Promise<ClientsSetup> => {
  const docId = generateDocId();
  const docBinding = createDocBinding();

  // Reference: local + RT + BC enabled (userId1)
  const referenceUserId = generateUserId();
  const referenceClient = createClientWithConfig({
    userId: referenceUserId,
    token: createTestToken(referenceUserId),
    docBinding,
    local: true,
  });

  // OtherTab: local + RT + BC enabled (same userId1 as reference)
  const otherTabClient = createClientWithConfig({
    userId: referenceUserId, // Same user for broadcast channel and IDB sharing
    token: createTestToken(referenceUserId),
    docBinding,
    local: true,
  });

  // OtherDevice: local enabled with different userId2, RT enabled, BC disabled
  const otherDeviceUserId = generateUserId();
  // Wait for reference and otherTab sockets to connect before creating otherDevice
  // This ensures they get their deviceId before we change it
  await new Promise((resolve) => setTimeout(resolve, 40));
  // Force a different deviceId for otherDevice to simulate a different physical device
  const newDeviceId = crypto.randomUUID();
  localStorage.setItem("docsync:deviceId", newDeviceId);
  const otherDeviceClient = createClientWithConfig({
    userId: otherDeviceUserId, // Different user = different IDB + BC namespace
    token: createTestToken(otherDeviceUserId),
    docBinding,
    local: true,
  });

  return {
    docId,
    reference: await createClientUtils(referenceClient, docId, referenceUserId),
    otherTab: await createClientUtils(otherTabClient, docId, referenceUserId),
    otherDevice: await createClientUtils(
      otherDeviceClient,
      docId,
      otherDeviceUserId,
    ),
  };
};

// ============================================================================
// Client Utils Factory
// ============================================================================

const createClientUtils = async (
  client: DocSyncClient<Doc, JsonDoc, Operations>,
  docId: string,
  userId: string,
): Promise<ClientUtils> => {
  let cleanup: (() => void) | undefined;
  let cachedDoc: Doc | undefined;

  const api = client["_serverSync"]["_api"];

  const reqSpy = vi.spyOn(api, "request");
  const local = await client["_localPromise"];

  return {
    client,
    get doc() {
      // Return our cached reference (matches what the client has)
      return cachedDoc;
    },
    reqSpy,
    loadDoc: async () => {
      if (cleanup) {
        throw new Error("Doc already loaded. Call unLoadDoc() first.");
      }
      await new Promise<void>((resolve, reject) => {
        cleanup = client.getDoc(
          { type: "test", id: docId, createIfMissing: true },
          (result) => {
            if (result.status === "success" && result.data) {
              cachedDoc = result.data.doc;
              resolve();
            }
            if (result.status === "error") {
              reject(result.error);
            }
          },
        );
      });
    },
    unLoadDoc: () => {
      if (cleanup) {
        cleanup();
        cleanup = undefined;
        cachedDoc = undefined; // Clear reference immediately
      }
    },
    addChild: (text: string) => {
      if (!cachedDoc) throw new Error("Doc not loaded");
      const child = cachedDoc.createNode(ChildNode);
      child.state.value.set(text);
      cachedDoc.root.append(child);
    },
    waitSync: async () => {
      const socket = api["_socket"];

      // If socket is not connected, this should fail fast
      if (!socket.connected) {
        throw new Error("Cannot wait for sync: socket not connected");
      }
      // Get current number of completed sync calls
      const initialCount = reqSpy.mock.results.filter(
        (_, i) => reqSpy.mock.calls[i]?.[0] === "sync-operations",
      ).length;

      // Wait for at least one more sync-operations to complete
      await vi.waitFor(
        async () => {
          const currentResults = reqSpy.mock.results.filter(
            (_, i) => reqSpy.mock.calls[i]?.[0] === "sync-operations",
          );

          expect(
            currentResults.length,
            "There should be at least one more sync-operations call",
          ).toBeGreaterThan(initialCount);

          // Ensure the last one has resolved
          await currentResults[currentResults.length - 1]?.value;
        },
        { timeout: 200, interval: 2 },
      );

      // Small delay for IDB consolidation
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    assertIDBDoc: async (expected?: {
      clock: number;
      doc: string[];
      ops: string[];
    }) => {
      // Get the provider from the client's internal state
      if (!local) {
        throw new Error("Client has no local provider configured");
      }

      // Read the document AND operations from IndexedDB
      const result = await local.provider.transaction(
        "readonly",
        async (ctx) => {
          const docResult = await ctx.getSerializedDoc(docId);
          const operations = await ctx.getOperations({ docId });
          return { docResult, operations };
        },
      );

      if (!expected) {
        expect(result.docResult).toBeUndefined();
        expect(result.operations).toStrictEqual([]);
        return;
      }

      if (!result.docResult) {
        throw new Error(
          `Document ${docId} not found in IndexedDB for user ${userId}`,
        );
      }

      const deserializedDoc = client["_docBinding"].deserialize(
        result.docResult.serializedDoc,
      );

      const actualDocChildren: string[] = [];
      deserializedDoc.root.children().forEach((child) => {
        const typedChild = child as unknown as DocNode<typeof ChildNode>;
        actualDocChildren.push(typedChild.state.value.get());
      });

      const opsChildren: string[] = [];

      for (const batch of result.operations) {
        if (batch.length === 0) continue;
        for (const item of batch) {
          if (!Array.isArray(item) || item.length < 2) continue;
          const stateUpdates = item[1];
          if (!stateUpdates || typeof stateUpdates !== "object") continue;

          for (const [, nodeState] of Object.entries(stateUpdates)) {
            if (
              nodeState &&
              typeof nodeState === "object" &&
              "value" in nodeState
            ) {
              const jsonValue = nodeState.value;
              const parsedValue = JSON.parse(jsonValue) as string;
              opsChildren.push(parsedValue);
            }
          }
        }
      }

      expect({
        clock: result.docResult.clock,
        doc: actualDocChildren,
        ops: opsChildren,
      }).toStrictEqual(expected);
    },
    assertMemoryDoc: (expectedChildren?: string[]) => {
      if (!expectedChildren) {
        expect(cachedDoc).toBeUndefined();
        return;
      }

      if (!cachedDoc)
        throw new Error("Doc not loaded - cannot assert memory doc");

      const actualChildren: string[] = [];
      cachedDoc.root.children().forEach((child) => {
        const typedChild = child as unknown as DocNode<typeof ChildNode>;
        actualChildren.push(typedChild.state.value.get());
      });

      expect(actualChildren).toStrictEqual(expectedChildren);
    },
    disconnect: () => {
      api.disconnect();
    },
    connect: () => {
      api.connect();
    },
  };
};

export const emptyIDB = { clock: 0, doc: [], ops: [] };
