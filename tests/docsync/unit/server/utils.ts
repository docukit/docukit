import { expect, vi } from "vitest";

import { DocNodeBinding } from "@docukit/docsync/docnode";
import { DocSyncServer, inMemoryServerProvider } from "@docukit/docsync/server";
import {
  DocSyncClient,
  type ClientAuthConfig,
  type ClientProvider,
} from "@docukit/docsync/client";
import { Doc, type JsonDoc, type Operations } from "@docukit/docnode";
import { testDocConfig } from "../../int/utils.js";

vi.mock(
  process.env.CI
    ? "../../../../packages/docsync/dist/src/client/utils/localIdentity.js"
    : "../../../../packages/docsync/src/client/utils/localIdentity.js",
  () => ({
    readLocalMetadata: () => {
      const userId = localStorage.getItem("docsync:localUserId");
      return Promise.resolve({
        deviceId: localStorage.getItem("docsync:deviceId") ?? "test-device",
        identity: userId ? { userId } : undefined,
      });
    },
    saveLocalIdentity: ({ userId }: { userId: string }) => {
      localStorage.setItem("docsync:localUserId", userId);
      return Promise.resolve();
    },
    clearLocalIdentity: () => {
      localStorage.removeItem("docsync:localUserId");
      return Promise.resolve();
    },
  }),
);

type TestClient = DocSyncClient<Doc, JsonDoc, Operations>;

// Auto-assign unique port range based on Vitest worker ID
// This allows test files to run in parallel without port conflicts
// Each worker gets 100 ports (worker 1: 8888-8987, worker 2: 8988-9087, etc.)
const BASE_PORT = (() => {
  const poolId = parseInt(process.env.VITEST_POOL_ID ?? "1", 10);
  return 8888 + (poolId - 1) * 100;
})();

// Helper to get ports with offset from base (for manual server creation in tests)
export const testPort = (offset = 0) => BASE_PORT + offset;

const createMockDocSyncClient = (serverOverrides?: {
  url?: string;
  auth?: ClientAuthConfig;
  localUserId?: string;
}): TestClient => {
  // mock window
  globalThis.window = {} as Window & typeof globalThis;
  // mock localStorage
  const storage = new Map<string, string>([["docsync:deviceId", "asd"]]);
  if (serverOverrides?.localUserId !== undefined) {
    storage.set("docsync:localUserId", serverOverrides.localUserId);
  }
  globalThis.localStorage = {
    clear: () => storage.clear(),
    getItem: (key) => storage.get(key) ?? null,
    key: (index) => Array.from(storage.keys())[index] ?? null,
    get length() {
      return storage.size;
    },
    removeItem: (key) => {
      storage.delete(key);
    },
    setItem: (key, value) => {
      storage.set(key, value);
    },
  } satisfies Storage;

  return new DocSyncClient({
    server: {
      url: serverOverrides?.url ?? `ws://localhost:${BASE_PORT}`,
      auth: serverOverrides?.auth ?? {
        mode: "token",
        getToken: () => "test-token",
      },
    },
    local: { provider: () => createTestClientProvider() },
    docBinding: DocNodeBinding([]),
  });
};

export const createTestClientProvider = (): ClientProvider<
  JsonDoc,
  Operations
> => ({
  transaction: (_mode, callback) =>
    callback({
      getSerializedDoc: () => Promise.resolve(undefined),
      getOperations: () => Promise.resolve([]),
      deleteOperations: () => Promise.resolve(undefined),
      saveOperations: () => Promise.resolve(undefined),
      saveSerializedDoc: () => Promise.resolve(undefined),
    }),
});

type TestServerProvider = ReturnType<typeof inMemoryServerProvider>;

const createServer = (port: number, provider: TestServerProvider) => {
  return new DocSyncServer({
    docBinding: DocNodeBinding([testDocConfig]),
    port,
    provider,
    authenticate: ({ token }) => {
      if (token?.startsWith("valid-")) {
        return { userId: token.replace("valid-", "") };
      }
    },
  });
};

/**
 * The real in-memory provider, with transactions that can be held open after
 * they read the log. This forces interleavings a socket cannot produce on
 * demand, without replacing any storage behaviour.
 */
export const createHoldableProvider = () => {
  const inner = inMemoryServerProvider();
  const holds = new Map<number, number>();
  const pendingChecks = new Set<() => void>();
  let requested = 0;

  const requestedAtLeast = (count: number) =>
    new Promise<void>((resolve) => {
      const check = () => {
        if (requested < count) return;
        pendingChecks.delete(check);
        resolve();
      };
      pendingChecks.add(check);
      check();
    });

  const provider: TestServerProvider = {
    transaction: (options, callback) => {
      const number = ++requested;
      pendingChecks.forEach((check) => {
        check();
      });
      const until = holds.get(number);
      return inner.transaction(options, (ctx) =>
        callback({
          ...ctx,
          getOperations: async (args) => {
            const batches = await ctx.getOperations(args);
            if (until !== undefined) await requestedAtLeast(until);
            return batches;
          },
        }),
      );
    },
  };

  return {
    provider,
    /**
     * Counting from this call, holds the given `transaction` open until `until`
     * transactions have been requested. Queued ones count, so nothing deadlocks.
     */
    hold: (...entries: { transaction: number; until: number }[]) => {
      for (const { transaction, until } of entries) {
        holds.set(requested + transaction, requested + until);
      }
    },
  };
};

export async function testWrapper(
  serverOverrides: {
    url?: string;
    auth?: ClientAuthConfig;
    port?: number;
    localUserId?: string;
    provider?: TestServerProvider;
  },
  fn: (args: {
    server: DocSyncServer;
    client: TestClient;
    waitForConnect: () => Promise<void>;
    waitForError: () => Promise<Error>;
    sync: (payload: SyncPayloadInput) => Promise<SyncResponse>;
    /** Sends `count` operations to the server, one sync per operation. */
    syncOperations: (docId: string, count: number) => Promise<void>;
    /** Stores a snapshot at clock 0, then `count` operations after it. */
    seedDocument: (docId: string, count: number) => Promise<JsonDoc>;
    /** What the server has stored for the document. */
    storedState: (
      docId: string,
    ) => Promise<{
      snapshot: { serializedDoc: JsonDoc; clock: number } | undefined;
      batches: Operations[][];
    }>;
    socket: TestClient["_socket"];
  }) => Promise<void>,
) {
  const port = serverOverrides.port ?? BASE_PORT;
  const provider = serverOverrides.provider ?? inMemoryServerProvider();
  const server = createServer(port, provider);
  const client = createMockDocSyncClient({
    ...serverOverrides,
    url: serverOverrides.url ?? `ws://localhost:${port}`,
  });
  const socket = client["_socket"];
  const waitForConnect = () =>
    new Promise<void>((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("connect_error", reject);
    });
  const waitForError = () =>
    new Promise<Error>((resolve) => {
      socket.on("connect_error", resolve);
    });
  const sync = (payload: SyncPayloadInput) =>
    new Promise<SyncResponse>((resolve) => {
      socket.emit("sync", s(payload), resolve);
    });

  const syncOperations = async (docId: string, count: number) => {
    for (let clock = 0; clock < count; clock++) {
      const res = await sync({
        docId,
        operations: [createTestOperation()],
        clock,
      });
      expect(res).toMatchObject({ data: { clock: clock + 1 } });
    }
  };

  const seedDocument = async (docId: string, count: number) => {
    const docBinding = DocNodeBinding([testDocConfig]);
    const serializedDoc = docBinding.serialize(
      docBinding.create("test", docId).doc,
    );
    await sync({ docId, serializedDoc, clock: 0 });
    await syncOperations(docId, count);
    return serializedDoc;
  };

  const storedState = (docId: string) =>
    provider.transaction({ mode: "readonly", docId }, async (ctx) => ({
      snapshot: await ctx.getSerializedDoc({ docId }),
      batches: await ctx.getOperations({ docId, clock: 0 }),
    }));

  await fn({
    server,
    seedDocument,
    storedState,
    client,
    waitForConnect,
    waitForError,
    socket,
    sync,
    syncOperations,
  });
  await server.close();
}

type SyncPayload = {
  type: string;
  docId: string;
  operations: Operations[];
  serializedDoc: JsonDoc | null;
  clock: number;
};
type SyncPayloadInput = Partial<SyncPayload>;
type SyncResponse =
  | {
      data: {
        docId: string;
        clock: number;
        operations: Operations[];
        serializedDoc: JsonDoc | null;
      };
    }
  | {
      error: {
        type: "AuthorizationError" | "DatabaseError" | "ValidationError";
        message: string;
      };
    };

export const s = (payload: SyncPayloadInput = {}): SyncPayload => ({
  type: "test",
  docId: "test-doc",
  operations: [],
  serializedDoc: null,
  clock: 0,
  ...payload,
});

export function createTestOperation(): Operations {
  const doc = new Doc(testDocConfig);
  const childNodeDef = testDocConfig.extensions[0]?.nodes?.[0];
  if (!childNodeDef) throw new Error("Missing child node definition");

  let capturedOperations: Operations | undefined;
  const unregister = doc.onChange((event) => {
    capturedOperations = event.operations;
  });

  doc.root.append(doc.createNode(childNodeDef));
  doc.forceCommit();
  unregister();

  if (!capturedOperations) throw new Error("Expected captured operations");
  return capturedOperations;
}
