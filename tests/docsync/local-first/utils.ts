import {
  DocSyncClient,
  IndexedDBProvider,
  type ClientConfig,
} from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { defineNode, type Doc, type JsonDoc, type Operations } from "docnode";
import { ulid } from "ulid";

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
export const getTestServerUrl = (): string => {
  const port = globalThis.__TEST_SERVER_PORT__ ?? 8082;
  return `ws://localhost:${port}`;
};

// Legacy export for backwards compatibility
export const TEST_SERVER_URL = getTestServerUrl();

// ============================================================================
// Node Definitions
// ============================================================================

export const TestNode = defineNode({ type: "test", state: {} });
export const ChildNode = defineNode({ type: "child", state: {} });

// ============================================================================
// Doc Binding
// ============================================================================

export const createDocBinding = () =>
  DocNodeBinding([
    { type: "test", extensions: [{ nodes: [TestNode, ChildNode] }] },
  ]);

// ============================================================================
// Generators
// ============================================================================

let clientCounter = 0;

export const generateUserId = () =>
  `integration-user-${Date.now()}-${++clientCounter}`;

export const generateDocId = () => ulid().toLowerCase();

// ============================================================================
// Token Helpers
// ============================================================================

/**
 * Creates a test token for authentication.
 * Token format: "test-token-{userId}"
 */
export const createTestToken = (userId: string) => `test-token-${userId}`;

// ============================================================================
// Client Factory
// ============================================================================

/**
 * Creates a DocSyncClient connected to the test server.
 * Each client gets a unique userId for IndexedDB isolation.
 * The token encodes the userId for server authentication.
 */
export const createClient = (
  userId?: string,
  token?: string,
  options?: { realTime?: boolean; broadcastChannel?: boolean },
) => {
  const docBinding = createDocBinding();
  const actualUserId = userId ?? generateUserId();
  const actualToken = token ?? createTestToken(actualUserId);

  const config: ClientConfig<Doc, JsonDoc, Operations> = {
    server: {
      url: getTestServerUrl(),
      auth: { getToken: async () => actualToken },
    },
    docBinding,
    realTime: options?.realTime,
    broadcastChannel: options?.broadcastChannel,
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({
        userId: actualUserId,
        secret: "test-secret",
      }),
    },
  };

  return {
    client: new DocSyncClient(config),
    docBinding,
    userId: actualUserId,
  };
};

// ============================================================================
// Async Helpers
// ============================================================================

/** Wait for async operations */
export const tick = (ms = 10) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gets a document from a client, returning a promise that resolves on success.
 */
export const getDoc = (
  client: DocSyncClient<Doc, JsonDoc, Operations>,
  args: { type: string; id: string; createIfMissing?: boolean },
): Promise<Doc> => {
  return new Promise((resolve, reject) => {
    client.getDoc(args as Parameters<typeof client.getDoc>[0], (result) => {
      if (result.status === "success" && result.data) {
        resolve(result.data.doc);
      }
      if (result.status === "error") {
        reject(result.error);
      }
    });
  });
};

/**
 * Gets a document and returns both the doc and a cleanup function.
 * The cleanup function should be called to unload the document.
 */
export const getDocWithCleanup = (
  client: DocSyncClient<Doc, JsonDoc, Operations>,
  args: { type: string; id: string; createIfMissing?: boolean },
): Promise<{ doc: Doc; cleanup: () => void }> => {
  return new Promise((resolve, reject) => {
    const cleanup = client.getDoc(
      args as Parameters<typeof client.getDoc>[0],
      (result) => {
        if (result.status === "success" && result.data) {
          resolve({ doc: result.data.doc, cleanup });
        }
        if (result.status === "error") {
          reject(result.error);
        }
      },
    );
  });
};

// ============================================================================
// Spy Helpers
// ============================================================================

/**
 * Creates a spy on BroadcastChannel.postMessage for a client.
 * Returns the spy instance to verify calls.
 */
export const spyOnBroadcastChannel = (
  client: DocSyncClient<Doc, JsonDoc, Operations>,
) => {
  const broadcastChannel = client["_broadcastChannel"];
  if (!broadcastChannel) {
    throw new Error(
      "Cannot spy on BroadcastChannel - it's disabled or not initialized",
    );
  }

  // Manual spy wrapper because vi.spyOn doesn't work with BroadcastChannel in Playwright
  const calls: unknown[][] = [];
  const originalPostMessage =
    broadcastChannel.postMessage.bind(broadcastChannel);

  broadcastChannel.postMessage = (message: unknown) => {
    calls.push([message]);
    originalPostMessage(message);
  };

  return {
    mock: { calls },
    mockClear: () => {
      calls.length = 0;
    },
  };
};

/**
 * Creates a spy on ServerSync.saveRemote to verify dirty events trigger syncs.
 * Returns the spy instance to verify calls.
 */
export const spyOnDirtyEvent = (
  client: DocSyncClient<Doc, JsonDoc, Operations>,
) => {
  const serverSync = client["_serverSync"];
  if (!serverSync) {
    throw new Error("Client has no server sync configured");
  }

  // Manual spy wrapper because vi.spyOn doesn't work reliably in Playwright browser
  const calls: unknown[][] = [];
  const originalSaveRemote = serverSync.saveRemote.bind(serverSync);

  serverSync.saveRemote = (payload: { docId: string }) => {
    calls.push([payload]);
    originalSaveRemote(payload);
  };

  return {
    mock: { calls },
    mockClear: () => {
      calls.length = 0;
    },
  };
};
