/* eslint-disable @typescript-eslint/no-empty-object-type */
import { vi, type Mock } from "vitest";
import {
  DocSyncClient,
  IndexedDBProvider,
  type QueryResult,
  type DocData,
  type ClientConfig,
  type Identity,
} from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { type Doc, defineNode } from "docnode";

// ============================================================================
// Node Definitions
// ============================================================================

export const TestNode = defineNode({ type: "test", state: {} });
export const ChildNode = defineNode({ type: "child", state: {} });

// ============================================================================
// Config Factories
// ============================================================================

/**
 * Helper to create a ClientConfig with type inference and excess property checking.
 *
 * Using this wrapper forces inline object literals, which enables TypeScript's
 * excess property checking - catching typos and invalid properties at compile time.
 */
const createClientConfig = <D extends {}, S extends {}, O extends {}>(
  config: ClientConfig<D, S, O>,
): ClientConfig<D, S, O> => config;

const createMockDocBinding = () =>
  DocNodeBinding([
    { type: "test", extensions: [{ nodes: [TestNode, ChildNode] }] },
  ]);

/**
 * Generates a unique userId for test isolation.
 * Each test can use its own userId to get an isolated IndexedDB database.
 */
let testUserCounter = 0;
const generateTestUserId = () => `test-user-${++testUserCounter}`;

const createValidConfig = (userId?: string) =>
  createClientConfig({
    server: {
      url: "ws://localhost:8081",
      auth: {
        getToken: async () => "test-token",
      },
    },
    docBinding: createMockDocBinding(),
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({
        userId: userId ?? generateTestUserId(),
        secret: "test-secret",
      }),
    },
  });

// ============================================================================
// Client Factory
// ============================================================================

export const createClient = (userId?: string) =>
  new DocSyncClient(createValidConfig(userId));

/**
 * Creates a client with a spy on docBinding.dispose.
 * Useful for testing that listeners are properly cleaned up.
 */
export const createClientWithDisposeSpy = (userId?: string) => {
  const docBinding = createMockDocBinding();
  const disposeSpy = vi.spyOn(docBinding, "dispose");

  const config = createClientConfig({
    server: {
      url: "ws://localhost:8081",
      auth: {
        getToken: async () => "test-token",
      },
    },
    docBinding,
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({
        userId: userId ?? generateTestUserId(),
        secret: "test-secret",
      }),
    },
  });

  const client = new DocSyncClient(config);
  return { client, disposeSpy };
};

// ============================================================================
// Test Helpers
// ============================================================================

type DocCallback = Mock<
  (result: QueryResult<DocData<Doc> | undefined>) => void
>;

export const createCallback = () => vi.fn() as DocCallback;

/**
 * Waits for async operations to complete.
 * Use sparingly - prefer explicit waitFor conditions when possible.
 */
export const tick = (ms = 3) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extracts the successful result from a callback mock.
 */
export const getSuccessData = (callback: DocCallback) =>
  callback.mock.calls.find((c) => c[0].status === "success" && c[0].data)?.[0]
    ?.data;

/**
 * Extracts the error result from a callback mock.
 */
export const getErrorResult = (callback: DocCallback) =>
  callback.mock.calls.find((c) => c[0].status === "error")?.[0];

/**
 * Creates a mock provider that throws on transaction.
 */
export const createFailingProvider = (errorMessage: string) => {
  return class FailingProvider {
    constructor(_identity: Identity) {
      // Identity accepted but not used in failing provider
    }
    async transaction() {
      throw new Error(errorMessage);
    }
  };
};

/**
 * Creates a client with a custom provider class.
 */
export const createClientWithProvider = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ProviderClass: new (identity: Identity) => any,
) => {
  const config = createClientConfig({
    server: {
      url: "ws://localhost:8081",
      auth: {
        getToken: async () => "test-token",
      },
    },
    docBinding: createMockDocBinding(),
    local: {
      provider: ProviderClass,
      getIdentity: async () => ({
        userId: "test-user",
        secret: "test-secret",
      }),
    },
  });
  return new DocSyncClient(config);
};
