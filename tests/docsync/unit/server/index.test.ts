// Server unit tests - run in Node process for coverage
// (integration tests run server in globalSetup, excluded from coverage)

import { describe, test, expect } from "vitest";
import { waitForConnect, waitForError, syncOperations } from "./utils.js";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { DocSyncServer, InMemoryServerProvider } from "@docnode/docsync/server";
import { DocSyncClient } from "@docnode/docsync/client";
import type {
  Identity,
  Provider,
} from "../../../../packages/docsync/dist/src/client/types.js";

// Estoy cansado de estos type parameters requeridos. Usar mejor defaults
const createMockDocSyncClient = (serverOverrides?: {
  url?: string;
  auth?: { getToken: () => Promise<string> };
}) => {
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
  });
};

const createServer2 = () => {
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

describe("authentication", () => {
  test("rejects without token", async () => {
    const server = createServer2();
    const client = createMockDocSyncClient({
      auth: { getToken: async () => "" },
    });
    const socket = client["_api"]["_socket"];
    const error = await waitForError(socket);
    expect(error.message).toContain("no token provided");
    await server.close();
  });

  test("rejects invalid token0", async () => {
    const server = createServer2();
    const client = createMockDocSyncClient({
      auth: { getToken: async () => "test-token" },
    });
    const socket = client["_api"]["_socket"];
    const error = await waitForError(socket);
    expect(error.message).toContain("invalid token");
    await server.close();
  });
  // test("rejects without token", async () => {
  //   createServer();
  //   const error = await waitForError(connectAnonymous());
  //   expect(error.message).toContain("no token provided");
  // });

  test("accepts valid token", async () => {
    const server = createServer2();
    const client = createMockDocSyncClient({
      auth: { getToken: async () => "valid-user1" },
    });
    const socket = client["_api"]["_socket"];
    await waitForConnect(socket);
    expect(socket.connected).toBe(true);
    await server.close();
  });
});

describe("sync-operations", () => {
  test("returns incremented clock", async () => {
    createServer2();
    const client = createMockDocSyncClient({
      auth: { getToken: async () => "valid-user1" },
    });
    const socket = client["_api"]["_socket"];
    await waitForConnect(socket);

    const res = await syncOperations(socket, {
      docId: "doc-1",
      operations: [{ type: "insert" }],
      clock: 0,
    });

    expect(res).toMatchObject({ docId: "doc-1", clock: 1 });
  });
});
