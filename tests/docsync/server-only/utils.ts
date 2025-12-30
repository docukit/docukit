import { vi, type Mock } from "vitest";
import {
  DocSyncClient,
  IndexedDBProvider,
  type ClientConfig,
  type SerializedDoc,
} from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { defineNode, type Doc, type JsonDoc, type Operations } from "docnode";
import { ulid } from "ulid";

// prettier-ignore
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type ServerSync<D extends {}, S extends SerializedDoc, O extends {}> = NonNullable<
  DocSyncClient<D, S, O>["_serverSync"]
>;

// ============================================================================
// Node Definitions
// ============================================================================

export const TestNode = defineNode({ type: "test", state: {} });
export const ChildNode = defineNode({ type: "child", state: {} });

// ============================================================================
// Generators
// ============================================================================

let testUserCounter = 0;

/** Generates a unique userId for test isolation (separate IndexedDB databases) */
export const generateTestUserId = () =>
  `serversync-test-${Date.now()}-${++testUserCounter}`;

/** Generates a unique docId (must be lowercase ULID) */
export const generateDocId = () => ulid().toLowerCase();

// ============================================================================
// Doc Binding
// ============================================================================

export const createDocBinding = () =>
  DocNodeBinding([
    { type: "test", extensions: [{ nodes: [TestNode, ChildNode] }] },
  ]);

// ============================================================================
// Operations Factory
// ============================================================================

/** Creates test operations - the content doesn't matter for sync tests */
export const ops = (data?: Record<string, string>): Operations =>
  [[], data ? { testNode: data } : {}] as Operations;

/** Empty operations */
export const emptyOps = (): Operations => [[], {}] as Operations;

// ============================================================================
// Mock API
// ============================================================================

export interface MockApi {
  request: Mock;
}

export const createMockApi = (): MockApi => ({
  request: vi.fn().mockResolvedValue({
    docId: "test-doc",
    operations: [],
    serializedDoc: null,
    clock: 1,
  }),
});

// ============================================================================
// ServerSync Factory
// ============================================================================

export interface ServerSyncTestContext {
  serverSync: ServerSync<Doc, JsonDoc, Operations>;
  docBinding: ReturnType<typeof createDocBinding>;
  provider: IndexedDBProvider<JsonDoc, Operations>;
  client: DocSyncClient<Doc, JsonDoc, Operations>;
}

/**
 * Creates a DocSyncClient and accesses its internal ServerSync.
 * Returns the ServerSync, docBinding, and provider for test manipulation.
 */
export const createServerSync = async (
  mockApi: MockApi,
): Promise<ServerSyncTestContext> => {
  const docBinding = createDocBinding();
  const userId = generateTestUserId();

  const config: ClientConfig<Doc, JsonDoc, Operations> = {
    server: {
      url: "ws://localhost:8081",
      auth: { getToken: async () => "test-token" },
    },
    docBinding,
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({ userId, secret: "test-secret" }),
    },
  };

  const client = new DocSyncClient(config);

  // Wait for lazy initialization to create the provider and ServerSync
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const local = await client["_localPromise"];
  if (!local) throw new Error("Local not initialized");

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const provider = local.provider as IndexedDBProvider<JsonDoc, Operations>;

  // Access the internal ServerSync and replace its API with our mock
  const serverSync = client["_serverSync"];
  if (!serverSync) throw new Error("ServerSync not initialized");
  // @ts-expect-error - TODO: fix this
  serverSync["_api"] = mockApi;

  return { serverSync, docBinding, provider, client };
};

// ============================================================================
// Async Helpers
// ============================================================================

/** Wait for async operations to complete */
export const tick = (ms = 5) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Doc Setup Helper
// ============================================================================

/**
 * Sets up a doc with an initial serialized state and optional operations.
 * This is the common setup pattern used across most tests.
 */
export const setupDocWithOperations = async (
  docBinding: ReturnType<typeof createDocBinding>,
  provider: IndexedDBProvider<JsonDoc, Operations>,
  docId: string,
  options: {
    clock?: number;
    operations?: Operations[];
  } = {},
) => {
  const { clock = 0, operations = [emptyOps()] } = options;
  const { doc } = docBinding.new("test", docId);

  await provider.transaction("readwrite", async (ctx) => {
    await ctx.saveSerializedDoc({
      serializedDoc: docBinding.serialize(doc),
      docId,
      clock,
    });
    await ctx.saveOperations({ docId, operations });
  });

  return { doc };
};

/**
 * Saves operations to the provider (without a serialized doc).
 * Used when testing operations-only scenarios.
 */
export const saveOperations = async (
  provider: IndexedDBProvider<JsonDoc, Operations>,
  docId: string,
  operations: Operations[] = [emptyOps()],
) => {
  await provider.transaction("readwrite", (ctx) =>
    ctx.saveOperations({ docId, operations }),
  );
};

/**
 * Gets operations count from provider.
 */
export const getOperationsCount = async (
  provider: IndexedDBProvider<JsonDoc, Operations>,
  docId: string,
) => {
  const ops = await provider.transaction("readonly", (ctx) =>
    ctx.getOperations({ docId }),
  );
  return ops.length;
};

/**
 * Gets stored doc clock from provider.
 */
export const getStoredClock = async (
  provider: IndexedDBProvider<JsonDoc, Operations>,
  docId: string,
) => {
  const stored = await provider.transaction("readonly", (ctx) =>
    ctx.getSerializedDoc(docId),
  );
  return stored?.clock;
};
