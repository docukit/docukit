import {
  DocSyncClient,
  IndexedDBProvider,
  type ClientConfig,
} from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { defineNode, type Doc, type JsonDoc, type Operations } from "docnode";
import { ulid } from "ulid";

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
// Client Factory
// ============================================================================

/**
 * Creates a DocSyncClient for testing.
 */
export const createClient = async () => {
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

  // Wait for lazy initialization
  await client["_localPromise"];

  return client;
};

// ============================================================================
// Async Helpers
// ============================================================================

/** Wait for async operations to complete */
export const tick = (ms = 3) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Doc Setup Helper
// ============================================================================

/**
 * Sets up a doc with an initial serialized state and optional operations.
 * This is the common setup pattern used across most tests.
 */
export const setupDocWithOperations = async (
  client: DocSyncClient<Doc, JsonDoc, Operations>,
  docId: string,
  options: {
    clock?: number;
    operations?: Operations[];
  } = {},
) => {
  const { clock = 0, operations = [emptyOps()] } = options;
  const docBinding = client["_docBinding"];
  const provider = (await client["_localPromise"]).provider;
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
  client: DocSyncClient<Doc, JsonDoc, Operations>,
  docId: string,
  operations: Operations[] = [emptyOps()],
) => {
  const provider = (await client["_localPromise"]).provider;
  await provider.transaction("readwrite", (ctx) =>
    ctx.saveOperations({ docId, operations }),
  );
};

/**
 * Gets operations count from provider.
 */
export const getOperationsCount = async (
  client: DocSyncClient<Doc, JsonDoc, Operations>,
  docId: string,
) => {
  const provider = (await client["_localPromise"]).provider;
  const ops = await provider.transaction("readonly", (ctx) =>
    ctx.getOperations({ docId }),
  );
  return ops.flat().length;
};

/**
 * Gets stored doc clock from provider.
 */
export const getStoredClock = async (
  client: DocSyncClient<Doc, JsonDoc, Operations>,
  docId: string,
) => {
  const provider = (await client["_localPromise"]).provider;
  const stored = await provider.transaction("readonly", (ctx) =>
    ctx.getSerializedDoc(docId),
  );
  return stored?.clock;
};
