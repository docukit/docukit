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
export const createClient = (userId?: string, token?: string) => {
  const docBinding = createDocBinding();
  const actualUserId = userId ?? generateUserId();
  const actualToken = token ?? createTestToken(actualUserId);

  const config: ClientConfig<Doc, JsonDoc, Operations> = {
    server: {
      url: getTestServerUrl(),
      auth: { getToken: async () => actualToken },
    },
    docBinding,
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
