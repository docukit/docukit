import {
  DocSyncClient,
  IndexedDBProvider,
  type ClientConfig,
} from "@docukit/docsync/client";
import { ulid } from "ulid";
import { expect, vi, type Mock } from "vitest";
import type { TestAdapter } from "./adapters.js";

// Re-export for backward compatibility (used in unit/server/utils.ts)
export { testDocConfig } from "./adapters.js";

// Extend globalThis to include test server port (used by auth.browser.test.ts)
declare global {
  var __TEST_SERVER_PORT__: number | undefined;
}

// ============================================================================
// Miscellaneous
// ============================================================================

/**
 * Waits for async operations to complete.
 * Use sparingly - prefer explicit waitFor conditions when possible.
 */
export const tick = (ms = 3) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Constants
// ============================================================================

export const emptyIDB = { doc: [] as string[], ops: [] as string[] };

// ============================================================================
// Generators
// ============================================================================

let clientCounter = 0;
let testCounter = 0;

const generateUserId = () =>
  `integration-user-${Date.now()}-test${++testCounter}-${++clientCounter}`;

const generateDocId = () => ulid().toLowerCase();

// ============================================================================
// Token Helpers
// ============================================================================

const createTestToken = (userId: string) => `test-token-${userId}`;

// ============================================================================
// Types
// ============================================================================

export type ClientUtils = {
  doc: unknown;
  loadDoc: () => Promise<void>;
  unLoadDoc: () => void;
  addChild: (text: string) => void;
  forceCommit: () => void;
  setBatchDelay: (ms: number) => void;
  assertIDBDoc: (
    expected?: { doc: string[]; ops: string[] },
    opts?: { sorted?: boolean },
  ) => Promise<void>;
  assertMemoryDoc: (
    children?: string[],
    opts?: { sorted?: boolean },
  ) => Promise<void>;
  reqSpy: Mock<
    (
      event: string,
      payload: { docId: string; [key: string]: unknown },
    ) => Promise<unknown>
  >;
  disconnect: () => void;
  connect: () => void;
};

export type ClientsSetup = {
  docId: string;
  reference: ClientUtils;
  otherTab: ClientUtils;
  otherDevice: ClientUtils;
};

// ============================================================================
// Test Context Factory
// ============================================================================

export function createTestContext<
  D extends object,
  S extends object,
  O extends object,
>(adapter: TestAdapter<D, S, O>) {
  const createTestWrapper = () => {
    const docBinding = adapter.createDocBinding();

    const createClientWithConfig = (config: {
      userId: string;
      token: string;
    }): DocSyncClient<D, S, O> => {
      const clientConfig: ClientConfig<D, S, O> = {
        server: {
          url: adapter.serverUrl,
          auth: { getToken: () => config.token },
        },
        docBinding,
        local: {
          provider: IndexedDBProvider,
          getIdentity: () => ({ userId: config.userId, secret: "test-secret" }),
        },
      };
      return new DocSyncClient(clientConfig);
    };

    const createClientUtils = async (
      client: DocSyncClient<D, S, O>,
      docId: string,
    ): Promise<ClientUtils> => {
      let cleanup: (() => void) | undefined;
      let cachedDoc: D | undefined;

      const socket = client["_socket"];
      const reqSpy = vi.spyOn(socket, "emit") as unknown as Mock<
        (
          event: string,
          payload: { docId: string; [key: string]: unknown },
        ) => Promise<unknown>
      >;
      const local = await client["_localPromise"];

      return {
        get doc() {
          return cachedDoc;
        },
        reqSpy,
        loadDoc: async () => {
          if (cleanup) {
            throw new Error("Doc already loaded. Call unLoadDoc() first.");
          }
          await new Promise<void>((resolve, reject) => {
            cleanup = client.getDoc(
              { type: "test", id: docId, createIfMissing: true },
              (result) => {
                if (result.status === "success" && result.data) {
                  cachedDoc = result.data.doc;
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
            cachedDoc = undefined;
          }
        },
        addChild: (text: string) => {
          if (!cachedDoc) throw new Error("Doc not loaded");
          adapter.addChild(cachedDoc, text);
        },
        forceCommit: () => {
          if (cachedDoc && adapter.forceCommit) {
            adapter.forceCommit(cachedDoc);
          }
        },
        setBatchDelay: (ms: number) => {
          client["_batchDelay"] = ms;
        },
        assertIDBDoc: async (
          expected?: { doc: string[]; ops: string[] },
          opts?: { sorted?: boolean },
        ) => {
          const sorted = opts?.sorted ?? false;
          const maybeSort = (arr: string[]) => (sorted ? [...arr].sort() : arr);

          await expect
            .poll(async () => {
              if (!local) {
                throw new Error("Client has no local provider configured");
              }

              const result = await local.provider.transaction(
                "readonly",
                async (ctx) => {
                  const docResult = await ctx.getSerializedDoc(docId);
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
                throw new Error(`Document ${docId} not found in IndexedDB`);
              }

              const actualDocChildren = adapter.getDocChildren(
                docBinding,
                result.docResult.serializedDoc,
              );
              const opsChildren = adapter.getOpsChildren(result.operations);

              expect({
                doc: maybeSort(actualDocChildren),
                ops: maybeSort(opsChildren),
              }).toStrictEqual({
                doc: maybeSort(expected.doc),
                ops: maybeSort(expected.ops),
              });
              return true;
            })
            .toBe(true);
        },
        assertMemoryDoc: async (
          expectedChildren?: string[],
          opts?: { sorted?: boolean },
        ) => {
          const sorted = opts?.sorted ?? false;
          const maybeSort = (arr: string[]) => (sorted ? [...arr].sort() : arr);

          await expect
            .poll(() => {
              if (!expectedChildren) {
                expect(cachedDoc).toBeUndefined();
                return true;
              }

              if (!cachedDoc)
                throw new Error("Doc not loaded - cannot assert memory doc");

              const actualChildren = adapter.getChildren(cachedDoc);
              expect(maybeSort(actualChildren)).toStrictEqual(
                maybeSort(expectedChildren),
              );
              return true;
            })
            .toBe(true);
        },
        disconnect: () => {
          client.disconnect();
        },
        connect: () => {
          client.connect();
        },
      };
    };

    const setupClients = async (): Promise<{
      clients: ClientsSetup;
      rawClients: DocSyncClient<D, S, O>[];
    }> => {
      const docId = generateDocId();

      const referenceUserId = generateUserId();
      const referenceClient = createClientWithConfig({
        userId: referenceUserId,
        token: createTestToken(referenceUserId),
      });

      const otherTabClient = createClientWithConfig({
        userId: referenceUserId,
        token: createTestToken(referenceUserId),
      });

      const otherDeviceUserId = generateUserId();
      await new Promise((resolve) => setTimeout(resolve, 40));
      const newDeviceId = crypto.randomUUID();
      localStorage.setItem("docsync:deviceId", newDeviceId);
      const otherDeviceClient = createClientWithConfig({
        userId: otherDeviceUserId,
        token: createTestToken(otherDeviceUserId),
      });

      return {
        clients: {
          docId,
          reference: await createClientUtils(referenceClient, docId),
          otherTab: await createClientUtils(otherTabClient, docId),
          otherDevice: await createClientUtils(otherDeviceClient, docId),
        },
        rawClients: [referenceClient, otherTabClient, otherDeviceClient],
      };
    };

    return async (
      callback: (clients: ClientsSetup) => Promise<void>,
    ): Promise<void> => {
      const { clients, rawClients } = await setupClients();

      try {
        await callback(clients);
      } finally {
        clients.reference.unLoadDoc();
        clients.otherTab.unLoadDoc();
        clients.otherDevice.unLoadDoc();

        for (const client of rawClients) {
          const socket = client["_socket"];
          if (socket?.connected) {
            socket.disconnect();
          }
        }

        await tick(15);

        for (const client of rawClients) {
          client["_bcHelper"]?.close();
        }

        await tick(15);
      }
    };
  };

  return { testWrapper: createTestWrapper() };
}
