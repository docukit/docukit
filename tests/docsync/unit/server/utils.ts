/* eslint-disable @typescript-eslint/no-empty-object-type */
import { DocNodeBinding } from "@docukit/docsync/docnode";
import { DocSyncServer, InMemoryServerProvider } from "@docukit/docsync/server";
import { DocSyncClient, type Identity } from "@docukit/docsync/client";
import type { Provider } from "@docukit/docsync";
import { testDocConfig } from "../../int/utils.js";

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
  auth?: { getToken: () => Promise<string> };
}): DocSyncClient => {
  // mock window
  globalThis.window = {} as Window & typeof globalThis;
  // mock localStorage
  globalThis.localStorage = {
    getItem: () => "asd",
  } as unknown as Storage;

  return new DocSyncClient({
    server: {
      url: serverOverrides?.url ?? `ws://localhost:${BASE_PORT}`,
      auth: serverOverrides?.auth ?? {
        getToken: async () => "test-token",
      },
    },
    local: {
      provider: InMemoryServerProvider as unknown as new (
        identity: Identity,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ) => Provider<any, any, "client">,
      getIdentity: async () => ({
        userId: "test-user",
        secret: "test-secret",
      }),
    },
    docBinding: DocNodeBinding([]),
  }) as unknown as DocSyncClient;
};

const createServer = (port = BASE_PORT) => {
  return new DocSyncServer({
    docBinding: DocNodeBinding([testDocConfig]),
    port,
    provider: InMemoryServerProvider,
    authenticate: async ({ token }) => {
      if (token.startsWith("valid-")) {
        return { userId: token.replace("valid-", "") };
      }
    },
  });
};

export async function testWrapper(
  serverOverrides: {
    url?: string;
    auth?: { getToken: () => Promise<string> };
    port?: number;
  },
  fn: (args: {
    server: DocSyncServer;
    client: DocSyncClient;
    waitForConnect: () => Promise<void>;
    waitForError: () => Promise<Error>;
    sync: (payload: SyncPayload) => Promise<SyncResponse>;
    socket: DocSyncClient["_socket"];
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
  const sync = (payload: SyncPayload) =>
    new Promise<SyncResponse>((resolve) => {
      socket.emit("sync", payload, resolve);
    });

  await fn({
    server,
    client,
    waitForConnect,
    waitForError,
    socket,
    sync,
  });
  await server.close();
}

type SyncPayload = {
  docId: string;
  operations?: {}[];
  clock: number;
};
type SyncResponse =
  | {
      data: {
        docId: string;
        clock: number;
        operations?: unknown[];
        serializedDoc?: unknown;
      };
    }
  | {
      error: {
        type: "AuthorizationError" | "DatabaseError" | "ValidationError";
        message: string;
      };
    };
