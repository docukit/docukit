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

export const TEST_SERVER_URL = "ws://localhost:8082";

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
// Client Factory
// ============================================================================

/**
 * Creates a DocSyncClient connected to the test server.
 * Each client gets a unique userId for IndexedDB isolation.
 */
export const createClient = (userId?: string) => {
  const docBinding = createDocBinding();
  const actualUserId = userId ?? generateUserId();

  const config: ClientConfig<Doc, JsonDoc, Operations> = {
    server: {
      url: TEST_SERVER_URL,
      auth: { getToken: async () => "test-token" },
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
export const tick = (ms = 50) =>
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
