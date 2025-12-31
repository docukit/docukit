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
const getTestServerUrl = (): string => {
  const port = globalThis.__TEST_SERVER_PORT__ ?? 8082;
  return `ws://localhost:${port}`;
};

// ============================================================================
// Node Definitions
// ============================================================================

const TestNode = defineNode({ type: "test", state: {} });
const ChildNode = defineNode({ type: "child", state: {} });

// ============================================================================
// Doc Binding
// ============================================================================

const createDocBinding = () =>
  DocNodeBinding([
    { type: "test", extensions: [{ nodes: [TestNode, ChildNode] }] },
  ]);

// ============================================================================
// Generators
// ============================================================================

let clientCounter = 0;

const generateUserId = () =>
  `integration-user-${Date.now()}-${++clientCounter}`;

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
  assertIDBDoc: (children: string[]) => void;
  assertMemoryDoc: (children: string[]) => void;
};

export type ClientsSetup = {
  docId: string;
  reference: ClientUtils;
  otherTab: ClientUtils;
  otherTabAndUser: ClientUtils;
  otherDevice: ClientUtils;
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
  realTime: boolean;
  broadcastChannel: boolean;
}): DocSyncClient<Doc, JsonDoc, Operations> => {
  const clientConfig: ClientConfig<Doc, JsonDoc, Operations> = {
    server: {
      url: getTestServerUrl(),
      auth: { getToken: async () => config.token },
    },
    docBinding: config.docBinding,
    realTime: config.realTime,
    broadcastChannel: config.broadcastChannel,
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
// Setup Clients
// ============================================================================

export const setupClients = async (): Promise<ClientsSetup> => {
  const docId = generateDocId();
  const docBinding = createDocBinding();

  // Reference: local + RT + BC enabled
  const referenceUserId = generateUserId();
  const referenceClient = createClientWithConfig({
    userId: referenceUserId,
    token: createTestToken(referenceUserId),
    docBinding,
    local: true,
    realTime: true,
    broadcastChannel: true,
  });

  // OtherTab: local + RT + BC enabled (same user as reference)
  const otherTabClient = createClientWithConfig({
    userId: referenceUserId, // Same user for broadcast channel
    token: createTestToken(referenceUserId),
    docBinding,
    local: true,
    realTime: true,
    broadcastChannel: true,
  });

  // OtherTabAndUser: local + RT + BC enabled (different user - namespacing prevents BC messages)
  const otherTabAndUserUserId = generateUserId();
  const otherTabAndUserClient = createClientWithConfig({
    userId: otherTabAndUserUserId,
    token: createTestToken(otherTabAndUserUserId),
    docBinding,
    local: true,
    realTime: true,
    broadcastChannel: true,
  });

  // OtherDevice: NO local, RT enabled, BC disabled (different user)
  const otherDeviceUserId = generateUserId();
  const otherDeviceClient = createClientWithConfig({
    userId: otherDeviceUserId,
    token: createTestToken(otherDeviceUserId),
    docBinding,
    local: false,
    realTime: true,
    broadcastChannel: false,
  });

  return {
    docId,
    reference: createClientUtils(referenceClient, docId),
    otherTab: createClientUtils(otherTabClient, docId),
    otherTabAndUser: createClientUtils(otherTabAndUserClient, docId),
    otherDevice: createClientUtils(otherDeviceClient, docId),
  };
};

// ============================================================================
// Client Utils Factory
// ============================================================================

const createClientUtils = (
  client: DocSyncClient<Doc, JsonDoc, Operations>,
  docId: string,
): ClientUtils => {
  let doc: Doc | undefined;
  let cleanup: (() => void) | undefined;

  return {
    client,
    get doc() {
      return doc;
    },
    loadDoc: async () => {
      await new Promise<void>((resolve, reject) => {
        cleanup = client.getDoc(
          { type: "test", id: docId, createIfMissing: true },
          (result) => {
            if (result.status === "success" && result.data) {
              doc = result.data.doc;
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
      }
      doc = undefined;
    },
    addChild: (_text: string) => {
      if (!doc) throw new Error("Doc not loaded");
      const child = doc.createNode(ChildNode);
      doc.root.append(child);
    },
    assertIDBDoc: (_children: string[]) => {
      throw new Error("Not implemented yet");
    },
    assertMemoryDoc: (_children: string[]) => {
      throw new Error("Not implemented yet");
    },
  };
};
