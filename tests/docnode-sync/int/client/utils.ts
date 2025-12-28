import { vi, type Mock } from "vitest";
import {
  DocSyncClient,
  IndexedDBProvider,
  type QueryResult,
  type DocData,
} from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { type Doc, defineNode } from "docnode";

// ============================================================================
// Types
// ============================================================================

export type DocCallback = Mock<
  (result: QueryResult<DocData<Doc> | undefined>) => void
>;

// ============================================================================
// Node Definitions
// ============================================================================

export const TestNode = defineNode({ type: "test", state: {} });
export const ChildNode = defineNode({ type: "child", state: {} });

// ============================================================================
// Config Factories
// ============================================================================

export const createMockDocBinding = () =>
  DocNodeBinding([
    { type: "test", extensions: [{ nodes: [TestNode, ChildNode] }] },
  ]);

export const createValidConfig = () => ({
  url: "ws://localhost:8081",
  docBinding: createMockDocBinding(),
  auth: {
    getToken: async () => "test-token",
  },
});

export const createValidConfigWithLocal = () => ({
  ...createValidConfig(),
  local: {
    provider: IndexedDBProvider,
    getIdentity: async () => ({
      userId: "test-user",
      secret: "test-secret",
    }),
  },
});

// ============================================================================
// Client Factory
// ============================================================================

export const createClient = (withLocal = false) =>
  new DocSyncClient(
    withLocal ? createValidConfigWithLocal() : createValidConfig(),
  );

/**
 * Creates a client with a spy on docBinding.removeListeners.
 * Useful for testing that listeners are properly cleaned up.
 */
export const createClientWithRemoveListenersSpy = (withLocal = false) => {
  const docBinding = createMockDocBinding();
  const removeListenersSpy = vi.spyOn(docBinding, "removeListeners");

  const config = withLocal
    ? {
        ...createValidConfig(),
        docBinding,
        local: {
          provider: IndexedDBProvider,
          getIdentity: async () => ({
            userId: "test-user",
            secret: "test-secret",
          }),
        },
      }
    : { ...createValidConfig(), docBinding };

  const client = new DocSyncClient(config);
  return { client, removeListenersSpy };
};

// ============================================================================
// Test Helpers
// ============================================================================

export const createCallback = () => vi.fn() as DocCallback;

/**
 * Waits for async operations to complete.
 * Use sparingly - prefer explicit waitFor conditions when possible.
 */
export const tick = (ms = 50) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extracts the successful result from a callback mock.
 */
export const getSuccessData = (callback: DocCallback) =>
  callback.mock.calls.find((c) => c[0].status === "success" && c[0].data)?.[0]
    ?.data;
