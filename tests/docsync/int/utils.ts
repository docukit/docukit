import {
  DocSyncClient,
  IndexedDBProvider,
  type ClientConfig,
} from "@docukit/docsync/client";
import { DocNodeBinding } from "@docukit/docsync/docnode";
import {
  defineNode,
  string,
  type Doc,
  type JsonDoc,
  type Operations,
  type DocNode,
} from "@docukit/docnode";
import { ulid } from "ulid";
import { expect, vi, type Mock } from "vitest";

// ============================================================================
// Miscellaneous
// ============================================================================

/**
 * Waits for async operations to complete.
 * Use sparingly - prefer explicit waitFor conditions when possible.
 */
export const tick = (ms = 3) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

export const testDocConfig = {
  type: "test",
  extensions: [{ nodes: [ChildNode] }],
};

// ============================================================================
// Doc Binding
// ============================================================================

const createDocBinding = () => DocNodeBinding([testDocConfig]);

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
  assertMemoryDoc: (children?: string[]) => Promise<void>;
  reqSpy: Mock<
    (
      event: string,
      payload: { docId: string; [key: string]: unknown },
    ) => Promise<unknown>
  >;
  disconnect: () => void;
  connect: () => void;
};

type ClientsSetup = {
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
      const socket = client["_socket"];
      if (socket?.connected) {
        socket.disconnect();
      }
    }

    // Let disconnect handlers run (they call _sendMessage to notify other tabs).
    // Close BroadcastChannel only after that to avoid "Channel is closed" errors.
    await tick(15);

    for (const client of allClients) {
      const bc = client["_broadcastChannel"];
      if (bc) {
        bc.close();
      }
    }

    await tick(15);
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
}): DocSyncClient<Doc, JsonDoc, Operations> => {
  const clientConfig: ClientConfig<Doc, JsonDoc, Operations> = {
    server: {
      url: getTestServerUrl(),
      auth: { getToken: async () => config.token },
    },
    docBinding: config.docBinding,
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({
        userId: config.userId,
        secret: "test-secret",
      }),
    },
  };

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
  });

  // OtherTab: local + RT + BC enabled (same userId1 as reference)
  const otherTabClient = createClientWithConfig({
    userId: referenceUserId, // Same user for broadcast channel and IDB sharing
    token: createTestToken(referenceUserId),
    docBinding,
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

  const api = client;

  const socket = api["_socket"];
  const reqSpy = vi.spyOn(socket, "emit") as unknown as Mock<
    (
      event: string,
      payload: { docId: string; [key: string]: unknown },
    ) => Promise<unknown>
  >;
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
    assertIDBDoc: async (expected?: {
      clock: number;
      doc: string[];
      ops: string[];
    }) => {
      await expect
        .poll(async () => {
          if (!local) {
            throw new Error("Client has no local provider configured");
          }

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
            return true;
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
          return true;
        })
        .toBe(true);
    },
    assertMemoryDoc: async (expectedChildren?: string[]) => {
      await expect
        .poll(() => {
          if (!expectedChildren) {
            expect(cachedDoc).toBeUndefined();
            return true;
          }

          if (!cachedDoc)
            throw new Error("Doc not loaded - cannot assert memory doc");

          const actualChildren: string[] = [];
          cachedDoc.root.children().forEach((child) => {
            const typedChild = child as unknown as DocNode<typeof ChildNode>;
            actualChildren.push(typedChild.state.value.get());
          });

          expect(actualChildren).toStrictEqual(expectedChildren);
          return true;
        })
        .toBe(true);
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
