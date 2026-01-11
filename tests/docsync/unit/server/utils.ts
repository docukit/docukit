import { afterEach } from "vitest";
import { io } from "socket.io-client";
import {
  DocSyncServer,
  InMemoryServerProvider,
} from "@docnode/docsync/testing";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import type { Doc, JsonDoc, Operations } from "docnode";

// ============================================================================
// State
// ============================================================================

const TEST_PORT = 9999;
const SERVER_URL = `ws://localhost:${TEST_PORT}`;

type TestServer = DocSyncServer<unknown, Doc, JsonDoc, Operations>;
type TestSocket = ReturnType<typeof io>;

let server: TestServer | undefined;
let client: TestSocket | undefined;

// ============================================================================
// Setup / Cleanup
// ============================================================================

afterEach(async () => {
  client?.disconnect();
  client = undefined;
  await server?.close();
  server = undefined;
});

// ============================================================================
// Server Helpers
// ============================================================================

export const createServer = () => {
  server = new DocSyncServer({
    docBinding: DocNodeBinding([]),
    port: TEST_PORT,
    provider: InMemoryServerProvider,
    authenticate: async ({ token }) => {
      if (token.startsWith("valid-")) {
        return { userId: token.replace("valid-", "") };
      }
      return undefined;
    },
  });
  return server;
};

// ============================================================================
// Client Helpers
// ============================================================================

export const connect = (token: string, deviceId = "device-1"): TestSocket => {
  client = io(SERVER_URL, {
    auth: { token, deviceId },
    transports: ["websocket"],
    reconnection: false,
  });
  return client;
};

export const connectAnonymous = (): TestSocket => {
  client = io(SERVER_URL, {
    auth: { deviceId: "device-1" },
    transports: ["websocket"],
    reconnection: false,
  });
  return client;
};

export const waitForConnect = (socket: TestSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.on("connect", resolve);
    socket.on("connect_error", reject);
  });

export const waitForError = (socket: TestSocket) =>
  new Promise<Error>((resolve) => {
    socket.on("connect_error", resolve);
  });

/* eslint-disable @typescript-eslint/no-restricted-types -- API uses null */
type SyncPayload = {
  docId: string;
  operations: unknown[] | null;
  clock: number;
};
type SyncResponse = {
  docId: string;
  clock: number;
  operations: unknown[] | null;
};
/* eslint-enable @typescript-eslint/no-restricted-types */

export const syncOperations = (socket: TestSocket, payload: SyncPayload) =>
  new Promise<SyncResponse>((resolve) => {
    socket.emit("sync-operations", payload, resolve);
  });
