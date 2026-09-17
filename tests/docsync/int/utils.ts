import { seedMetadata } from "../metadataUtils.js";
import {
  DocSyncClient,
  indexedDBProvider,
  type ClientConfig,
} from "@docukit/docsync/client";
import { DocNodeBinding } from "@docukit/docsync/docnode";
import {
  defineNode,
  string,
  type Doc,
  type JsonDoc,
  type Operations,
  type DocNode,
} from "@docukit/docnode";
import { ulid } from "ulid";
import { expect, inject, vi, type Mock } from "vitest";

// ============================================================================
// Miscellaneous
// ============================================================================

/**
 * Waits for async operations to complete.
 * Use sparingly - prefer explicit waitFor conditions when possible.
 */
const tick = (ms = 3) => new Promise((resolve) => setTimeout(resolve, ms));
const animationFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const testBroadcastChannels = new Map<string, Set<TestBroadcastChannel>>();

class TestBroadcastChannel extends EventTarget implements BroadcastChannel {
  onmessage: ((this: BroadcastChannel, ev: MessageEvent) => unknown) | null =
    null;
  onmessageerror:
    | ((this: BroadcastChannel, ev: MessageEvent) => unknown)
    | null = null;

  #closed = false;

  constructor(readonly name: string) {
    super();
    const channels = testBroadcastChannels.get(name) ?? new Set();
    channels.add(this);
    testBroadcastChannels.set(name, channels);
  }

  postMessage(message: unknown): void {
    const channels = testBroadcastChannels.get(this.name);
    if (!channels) return;

    for (const channel of channels) {
      if (channel === this) continue;
      queueMicrotask(() => {
        if (channel.#closed) return;
        const event = new MessageEvent("message", { data: message });
        channel.onmessage?.call(channel, event);
        channel.dispatchEvent(event);
      });
    }
  }

  close(): void {
    this.#closed = true;
    const channels = testBroadcastChannels.get(this.name);
    if (!channels) return;
    channels.delete(this);
    if (channels.size === 0) {
      testBroadcastChannels.delete(this.name);
    }
  }
}

const testBroadcastChannel: typeof BroadcastChannel = TestBroadcastChannel;

export const waitForLocalBroadcast = async (): Promise<void> => {
  await animationFrame();
  await animationFrame();
};

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
  const injectedPort: number | undefined = inject("testServerPort");
  const port = injectedPort ?? globalThis.__TEST_SERVER_PORT__ ?? 8082;
  return `ws://localhost:${port}`;
};

// ============================================================================
// Node Definitions
// ============================================================================

const ChildNode = defineNode({ type: "child", state: { value: string("") } });

export const testDocConfig = {
  type: "test",
  extensions: [{ nodes: [ChildNode] }],
  // Integration tests assert individual undo steps, so do not merge adjacent
  // edits based on wall-clock timing.
  undoManager: { maxUndoSteps: 10, mergeInterval: 0 },
};

// ============================================================================
// Doc Binding
// ============================================================================

const createDocBinding = () => DocNodeBinding([testDocConfig]);

// ============================================================================
// Generators
// ============================================================================

const runId = crypto.randomUUID();
let clientCounter = 0;

const generateUserId = () => `integration-user-${runId}-${++clientCounter}`;

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

type EmitForTests = (
  event: string,
  payload: { docId: string; [key: string]: unknown },
  ack?: (response: unknown) => void,
) => void;

type ClientUtils = {
  client: DocSyncClient<Doc, JsonDoc, Operations>;
  doc: Doc | undefined;
  loadDoc: () => Promise<void>;
  unLoadDoc: () => void;
  addChild: (text: string) => void;
  addChildSkippingUndo: (text: string) => void;
  assertIDBDoc: (expected?: { doc: string[]; ops: string[] }) => Promise<void>;
  assertMemoryDoc: (children?: string[]) => Promise<void>;
  assertCanUndo: (expected: boolean) => Promise<void>;
  reqSpy: Mock<EmitForTests>;
  disconnect: () => void;
  connect: () => void;
  /**
   * Simulates a slow uplink for this client: the next sync request is built
   * normally (the pending batch is already read) but is not put on the wire
   * until `release()` is called.
   */
  holdNextSyncRequest: () => {
    captured: Promise<void>;
    release: () => void;
    restore: () => void;
  };
};

type ClientsSetup = {
  docId: string;
  reference: ClientUtils;
  otherTab: ClientUtils;
  otherDevice: ClientUtils;
};

// ============================================================================
// Test Wrapper (Setup + Cleanup)
// ============================================================================

/**
 * Test wrapper that creates clients, runs the test callback, and cleans up.
 * This ensures cleanup always happens, even if the test fails.
 */
export const testWrapper = async (
  callback: (clients: ClientsSetup) => Promise<void>,
): Promise<void> => {
  const clients = await setupClients();

  try {
    await callback(clients);
  } finally {
    // Cleanup: unload docs
    clients.reference.unLoadDoc();
    clients.otherTab.unLoadDoc();
    clients.otherDevice.unLoadDoc();

    // Cleanup: close connections
    const allClients = [
      clients.reference.client,
      clients.otherTab.client,
      clients.otherDevice.client,
    ];

    for (const client of allClients) {
      const socket = client["_socket"];
      if (socket?.connected) {
        socket.disconnect();
      }
    }

    // Let disconnect handlers run (they call _sendMessage to notify other tabs).
    // Close BroadcastChannel only after that to avoid "Channel is closed" errors.
    await tick(15);

    for (const client of allClients) {
      client["_bcHelper"]?.close();
    }

    await tick(15);
  }
};

// ============================================================================
// Client Factory
// ============================================================================

/**
 * Creates a DocSyncClient with specific configuration.
 */
const createClientWithConfig = async (config: {
  userId: string;
  deviceId: string;
  token: string;
  docBinding: ReturnType<typeof createDocBinding>;
}) => {
  await seedMetadata(config.userId, config.deviceId);

  const clientConfig: ClientConfig<Doc, JsonDoc, Operations> = {
    server: {
      url: getTestServerUrl(),
      auth: { mode: "token", getToken: () => config.token },
    },
    timing: { collabMaxDebounce: 50, singleClientMaxDebounce: 50 },
    docBinding: config.docBinding,
    local: { provider: indexedDBProvider },
  };

  const currentBroadcastChannel = globalThis.BroadcastChannel;
  globalThis.BroadcastChannel = testBroadcastChannel;
  try {
    const client = new DocSyncClient(clientConfig);
    await client["_localPromise"];
    return client;
  } finally {
    globalThis.BroadcastChannel = currentBroadcastChannel;
  }
};

// ============================================================================
// Client Setup (Internal)
// ============================================================================

const setupClients = async (): Promise<ClientsSetup> => {
  const docId = generateDocId();
  const docBinding = createDocBinding();

  // Reference: local + RT + BC enabled (userId1)
  const referenceUserId = generateUserId();
  const referenceDeviceId = crypto.randomUUID();
  const referenceClient = await createClientWithConfig({
    userId: referenceUserId,
    deviceId: referenceDeviceId,
    token: createTestToken(referenceUserId),
    docBinding,
  });

  // OtherTab: local + RT + BC enabled (same userId1 as reference)
  const otherTabClient = await createClientWithConfig({
    userId: referenceUserId, // Same user for broadcast channel and IDB sharing
    deviceId: referenceDeviceId,
    token: createTestToken(referenceUserId),
    docBinding,
  });

  // OtherDevice: local enabled with different userId2, RT enabled, BC disabled
  const otherDeviceUserId = generateUserId();
  const otherDeviceId = crypto.randomUUID();
  const otherDeviceClient = await createClientWithConfig({
    userId: otherDeviceUserId, // Different user = different IDB + BC namespace
    deviceId: otherDeviceId,
    token: createTestToken(otherDeviceUserId),
    docBinding,
  });

  return {
    docId,
    reference: await createClientUtils(referenceClient, docId, referenceUserId),
    otherTab: await createClientUtils(otherTabClient, docId, referenceUserId),
    otherDevice: await createClientUtils(
      otherDeviceClient,
      docId,
      otherDeviceUserId,
    ),
  };
};

// ============================================================================
// Client Utils Factory
// ============================================================================

const createClientUtils = async (
  client: DocSyncClient<Doc, JsonDoc, Operations>,
  docId: string,
  userId: string,
): Promise<ClientUtils> => {
  let cleanup: (() => void) | undefined;
  let cachedDoc: Doc | undefined;

  const api = client;

  const socket = api["_socket"];
  // Captured before the spy replaces `emit`, so a mocked implementation can
  // still put the real request on the wire. Narrowed the same way the client
  // narrows it in `request.ts`: every client-to-server event is (payload, ack).
  const sendToServer = socket.emit.bind(socket) as EmitForTests;
  const reqSpy = vi.spyOn(socket, "emit") as unknown as Mock<EmitForTests>;
  await expect
    .poll(async () => ({
      connected: client["_socket"].connected,
      userId: (await client["_localPromise"]).identity.userId,
    }))
    .toStrictEqual({ connected: true, userId });
  const local = await client["_localPromise"];

  return {
    client,
    get doc() {
      // Return our cached reference (matches what the client has)
      return cachedDoc;
    },
    reqSpy,
    loadDoc: async () => {
      if (cleanup) {
        throw new Error("Doc already loaded. Call unLoadDoc() first.");
      }
      await new Promise<void>((resolve, reject) => {
        const observer = client.getDocObserver({
          type: "test",
          id: docId,
          createIfMissing: true,
        });
        const handleResult = () => {
          const result = observer.getSnapshot();
          if (result.status === "success") {
            cachedDoc = result.data.doc;
            resolve();
          }
          if (result.status === "error") reject(result.error);
        };
        cleanup = observer.subscribe(handleResult);
        handleResult();
      });
    },
    unLoadDoc: () => {
      if (cleanup) {
        cleanup();
        cleanup = undefined;
        cachedDoc = undefined; // Clear reference immediately
      }
    },
    addChild: (text: string) => {
      if (!cachedDoc) throw new Error("Doc not loaded");
      const child = cachedDoc.createNode(ChildNode);
      child.state.value.set(text);
      cachedDoc.root.append(child);
    },
    addChildSkippingUndo: (text: string) => {
      if (!cachedDoc) throw new Error("Doc not loaded");
      const doc = cachedDoc;
      doc.forceCommit(
        () => {
          const child = doc.createNode(ChildNode);
          child.state.value.set(text);
          doc.root.append(child);
        },
        { skipUndo: true },
      );
    },
    assertIDBDoc: async (expected?: { doc: string[]; ops: string[] }) => {
      await expect
        .poll(async () => {
          if (!local) {
            throw new Error("Client has no local provider configured");
          }

          const result = await local.provider.transaction(
            "readonly",
            async (ctx) => {
              const docResult = await ctx.getSerializedDoc({ docId });
              const operations = await ctx.getOperations({ docId });
              return { docResult, operations };
            },
          );

          if (!expected) {
            expect(result.docResult).toBeUndefined();
            expect(result.operations).toStrictEqual([]);
            return true;
          }

          if (!result.docResult) {
            throw new Error(
              `Document ${docId} not found in IndexedDB for user ${userId}`,
            );
          }

          const deserializedDoc = client["_docBinding"].deserialize(
            result.docResult.serializedDoc,
          );

          const actualDocChildren: string[] = [];
          deserializedDoc.root.children().forEach((child) => {
            const typedChild = child as unknown as DocNode<typeof ChildNode>;
            actualDocChildren.push(typedChild.state.value.get());
          });

          const opsChildren: string[] = [];

          for (const { operations: batch } of result.operations) {
            if (batch.length === 0) continue;
            for (const item of batch) {
              if (!Array.isArray(item) || item.length < 2) continue;
              const stateUpdates = item[1];
              if (!stateUpdates || typeof stateUpdates !== "object") continue;

              for (const [, nodeState] of Object.entries(stateUpdates)) {
                if (
                  nodeState &&
                  typeof nodeState === "object" &&
                  "value" in nodeState
                ) {
                  const jsonValue = nodeState.value;
                  const parsedValue = JSON.parse(jsonValue) as string;
                  opsChildren.push(parsedValue);
                }
              }
            }
          }

          expect({ doc: actualDocChildren, ops: opsChildren }).toStrictEqual(
            expected,
          );
          return true;
        })
        .toBe(true);
    },
    assertMemoryDoc: async (expectedChildren?: string[]) => {
      await expect
        .poll(() => {
          if (!expectedChildren) {
            expect(cachedDoc).toBeUndefined();
            return true;
          }

          if (!cachedDoc)
            throw new Error("Doc not loaded - cannot assert memory doc");

          const actualChildren: string[] = [];
          cachedDoc.root.children().forEach((child) => {
            const typedChild = child as unknown as DocNode<typeof ChildNode>;
            actualChildren.push(typedChild.state.value.get());
          });

          expect(actualChildren).toStrictEqual(expectedChildren);
          return true;
        })
        .toBe(true);
    },
    assertCanUndo: async (expected: boolean) => {
      await expect
        .poll(() => {
          if (!cachedDoc) throw new Error("Doc not loaded");
          return cachedDoc.undoManager.canUndo();
        })
        .toBe(expected);
    },
    disconnect: () => {
      api.disconnect();
    },
    connect: () => {
      api.connect();
    },
    holdNextSyncRequest: () => {
      let markCaptured!: () => void;
      const captured = new Promise<void>((resolve) => {
        markCaptured = resolve;
      });
      let held: (() => void) | undefined;
      let alreadyHeld = false;
      const release = () => {
        const send = held;
        held = undefined;
        send?.();
      };
      reqSpy.mockImplementation((event, payload, ack) => {
        if (event !== "sync" || alreadyHeld) {
          sendToServer(event, payload, ack);
          return;
        }
        alreadyHeld = true;
        held = () => sendToServer(event, payload, ack);
        markCaptured();
      });
      return {
        captured,
        release,
        restore: () => {
          release();
          // `reqSpy` belongs to these utils, not to this helper: go back to
          // passing requests through and keep recording them.
          reqSpy.mockImplementation(sendToServer);
        },
      };
    },
  };
};

export const emptyIDB = { doc: [], ops: [] };

export const runWorkerClient = async (input: {
  token: string;
  docId: string;
  offline?: boolean;
  edit?: string;
}) => {
  const worker = new Worker(new URL("./client.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const result = new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
    });
    worker.postMessage({
      ...input,
      serverUrl: `ws://localhost:${inject("testServerPort")}`,
    });
    return await result;
  } finally {
    worker.terminate();
  }
};
