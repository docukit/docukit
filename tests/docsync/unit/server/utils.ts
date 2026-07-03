import { DocNodeBinding } from "@docukit/docsync/docnode";
import { DocSyncServer, inMemoryServerProvider } from "@docukit/docsync/server";
import {
  DocSyncClient,
  type ClientAuthConfig,
  type ClientProvider,
} from "@docukit/docsync/client";
import { Doc, type JsonDoc, type Operations } from "@docukit/docnode";
import { testDocConfig } from "../../int/utils.js";

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

const createServer = (port = BASE_PORT) => {
  return new DocSyncServer({
    docBinding: DocNodeBinding([testDocConfig]),
    port,
    provider: inMemoryServerProvider(),
    authenticate: ({ token }) => {
      if (token?.startsWith("valid-")) {
        return { userId: token.replace("valid-", "") };
      }
    },
  });
};

export async function testWrapper(
  serverOverrides: {
    url?: string;
    auth?: ClientAuthConfig;
    port?: number;
    localUserId?: string;
  },
  fn: (args: {
    server: DocSyncServer;
    client: TestClient;
    waitForConnect: () => Promise<void>;
    waitForError: () => Promise<Error>;
    sync: (payload: SyncPayloadInput) => Promise<SyncResponse>;
    socket: TestClient["_socket"];
  }) => Promise<void>,
) {
  const port = serverOverrides.port ?? BASE_PORT;
  const server = createServer(port);
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
      socket.emit(
        "sync",
        { type: "test", operations: [], clock: 0, ...payload },
        resolve,
      );
    });

  await fn({ server, client, waitForConnect, waitForError, socket, sync });
  await server.close();
}

type SyncPayload = {
  type: string;
  docId: string;
  operations: Operations[];
  clock: number;
};
type SyncPayloadInput = Pick<SyncPayload, "docId"> &
  Partial<Omit<SyncPayload, "docId">>;
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
