/* eslint-disable @typescript-eslint/no-empty-object-type */
import { vi, type Mock } from "vitest";
import {
  DocSyncClient,
  indexedDBProvider,
  type QueryResult,
  type DocData,
  type ClientConfig,
  type Identity,
} from "@docukit/docsync/client";
import { DocNodeBinding } from "@docukit/docsync/docnode";
import {
  type Doc,
  type JsonDoc,
  type Operations,
  defineNode,
} from "@docukit/docnode";

// ============================================================================
// Node Definitions
// ============================================================================

export const TestNode = defineNode({ type: "test" });
export const ChildNode = defineNode({ type: "child" });

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

const createDocBinding = () =>
  DocNodeBinding([
    { type: "test", extensions: [{ nodes: [TestNode, ChildNode] }] },
  ]);

export const LOCAL_IDENTITY_KEY = "docsync:localUserId";

export const cacheLocalIdentity = (userId: string) => {
  localStorage.setItem(LOCAL_IDENTITY_KEY, userId);
};

export const clearCachedLocalIdentity = () => {
  localStorage.removeItem(LOCAL_IDENTITY_KEY);
};

const createValidConfig = () =>
  createClientConfig({
    server: {
      url: "ws://localhost:8081",
      auth: { mode: "token", getToken: () => "test-token" },
    },
    docBinding: createDocBinding(),
    local: { provider: indexedDBProvider },
  });

// ============================================================================
// Client Factory
// ============================================================================

export const createClient = (userId = "mock-user") => {
  cacheLocalIdentity(userId);
  return new DocSyncClient(createValidConfig());
};

/**
 * Creates a client with a spy on docBinding.dispose.
 * Useful for testing that listeners are properly cleaned up.
 */
export const createClientWithDisposeSpy = (userId = "mock-user") => {
  const docBinding = createDocBinding();
  const disposeSpy = vi.spyOn(docBinding, "dispose");
  cacheLocalIdentity(userId);

  const config = createClientConfig({
    server: {
      url: "ws://localhost:8081",
      auth: { mode: "token", getToken: () => "test-token" },
    },
    docBinding,
    local: { provider: indexedDBProvider },
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
 * Creates a provider that throws on transaction.
 */
export const createFailingProvider = (errorMessage: string) => {
  return (_identity: Identity) => ({
    // eslint-disable-next-line @typescript-eslint/require-await -- sync implementation of async interface
    async transaction() {
      throw new Error(errorMessage);
    },
  });
};

/**
 * Creates a client with a custom provider class.
 */
export const createClientWithProvider = (
  ProviderClass: ClientConfig<Doc, JsonDoc, Operations>["local"]["provider"],
  localUserId?: string,
) => {
  if (localUserId !== undefined) {
    cacheLocalIdentity(localUserId);
  }

  const config = createClientConfig({
    server: {
      url: "ws://localhost:8081",
      auth: { mode: "token", getToken: () => "test-token" },
    },
    docBinding: createDocBinding(),
    local: { provider: ProviderClass },
  });
  return new DocSyncClient(config);
};
