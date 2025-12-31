import {
  DocSyncClient,
  IndexedDBProvider,
  type ClientConfig,
} from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import {
  defineNode,
  string,
  type Doc,
  type JsonDoc,
  type Operations,
  type DocNode,
} from "docnode";
import { ulid } from "ulid";
import { expect } from "vitest";

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

// ============================================================================
// Doc Binding
// ============================================================================

const createDocBinding = () =>
  DocNodeBinding([{ type: "test", extensions: [{ nodes: [ChildNode] }] }]);

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
  assertIDBDoc: (children: string[]) => Promise<void>;
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
    reference: createClientUtils(referenceClient, docId, referenceUserId),
    otherTab: createClientUtils(otherTabClient, docId, referenceUserId),
    otherTabAndUser: createClientUtils(
      otherTabAndUserClient,
      docId,
      otherTabAndUserUserId,
    ),
    otherDevice: createClientUtils(otherDeviceClient, docId, otherDeviceUserId),
  };
};

// ============================================================================
// Client Utils Factory
// ============================================================================

const createClientUtils = (
  client: DocSyncClient<Doc, JsonDoc, Operations>,
  docId: string,
  userId: string,
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
    addChild: (text: string) => {
      if (!doc) throw new Error("Doc not loaded");
      const child = doc.createNode(ChildNode);
      child.state.value.set(text);
      doc.root.append(child);
    },
    assertIDBDoc: async (expectedChildren: string[]) => {
      // Get the provider from the client's internal state
      const local = await client["_localPromise"];
      if (!local) {
        throw new Error("Client has no local provider configured");
      }

      // Read the document from IndexedDB using the provider
      const result = await local.provider.transaction(
        "readonly",
        async (ctx) => {
          return await ctx.getSerializedDoc(docId);
        },
      );

      if (!result) {
        throw new Error(
          `Document ${docId} not found in IndexedDB for user ${userId}`,
        );
      }

      // Deserialize using the client's docBinding
      const deserializedDoc = client["_docBinding"].deserialize(
        result.serializedDoc,
      );

      // TODO: assert also operations

      const actualChildren: string[] = [];
      deserializedDoc.root.children().forEach((child) => {
        const typedChild = child as unknown as DocNode<typeof ChildNode>;
        actualChildren.push(typedChild.state.value.get());
      });

      expect(actualChildren).toStrictEqual(expectedChildren);
    },
    assertMemoryDoc: (expectedChildren: string[]) => {
      if (!doc) throw new Error("Doc not loaded - cannot assert memory doc");

      const actualChildren: string[] = [];
      doc.root.children().forEach((child) => {
        const typedChild = child as unknown as DocNode<typeof ChildNode>;
        actualChildren.push(typedChild.state.value.get());
      });

      expect(actualChildren).toStrictEqual(expectedChildren);
    },
  };
};
