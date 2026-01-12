/* eslint-disable @typescript-eslint/no-empty-object-type */
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { DocSyncServer, InMemoryServerProvider } from "@docnode/docsync/server";
import { DocSyncClient } from "@docnode/docsync/client";
import type {
  Identity,
  Provider,
} from "../../../../packages/docsync/dist/src/client/types.js";

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
      url: serverOverrides?.url ?? "ws://localhost:8888",
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

const createServer = () => {
  return new DocSyncServer({
    docBinding: DocNodeBinding([]),
    port: 8888,
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
  },
  fn: (args: {
    server: DocSyncServer;
    client: DocSyncClient;
    waitForConnect: () => Promise<void>;
    waitForError: () => Promise<Error>;
    syncOperations: (payload: SyncPayload) => Promise<SyncResponse>;
    socket: DocSyncClient["_api"]["_socket"];
  }) => Promise<void>,
) {
  const server = createServer();
  const client = createMockDocSyncClient(serverOverrides);
  const socket = client["_api"]["_socket"];
  const waitForConnect = () =>
    new Promise<void>((resolve, reject) => {
      socket.on("connect", resolve);
      socket.on("connect_error", reject);
    });
  const waitForError = () =>
    new Promise<Error>((resolve) => {
      socket.on("connect_error", resolve);
    });
  const syncOperations = (payload: SyncPayload) =>
    new Promise<SyncResponse>((resolve) => {
      socket.emit("sync-operations", payload, resolve);
    });

  await fn({
    server,
    client,
    waitForConnect,
    waitForError,
    socket,
    syncOperations,
  });
  await server.close();
}

/* eslint-disable @typescript-eslint/no-restricted-types -- API uses null */
type SyncPayload = {
  docId: string;
  operations: {}[] | null;
  clock: number;
};
type SyncResponse = {
  docId: string;
  clock: number;
  operations: unknown[] | null;
};
