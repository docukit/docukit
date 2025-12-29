import { describe, test, expect, afterEach } from "vitest";
import { DocSyncServer } from "../../../packages/docsync/src/server/index.js";
import {
  createServerConfig,
  closeServer,
  createClient,
  disconnectClient,
  getUniquePort,
} from "./utils.js";
import type { Socket } from "socket.io-client";

// ============================================================================
// Tests
// ============================================================================

describe("DocSyncServer", () => {
  const servers: DocSyncServer<unknown, unknown, unknown>[] = [];
  const clients: Socket[] = [];

  afterEach(() => {
    clients.forEach(disconnectClient);
    clients.length = 0;
    servers.forEach(closeServer);
    servers.length = 0;
  });

  const createServer = (
    ...args: Parameters<typeof createServerConfig>
  ): {
    server: DocSyncServer<unknown, unknown, unknown>;
    syncSpy: ReturnType<typeof createServerConfig>["syncSpy"];
    port: number;
  } => {
    const port = args[0]?.port ?? getUniquePort();
    const { config, syncSpy } = createServerConfig({ ...args[0], port });
    const server = new DocSyncServer(config);
    servers.push(server);
    return { server, syncSpy, port };
  };

  const connectClient = (port: number): Promise<Socket> => {
    return new Promise((resolve) => {
      const client = createClient(port);
      clients.push(client);
      client.on("connect", () => resolve(client));
    });
  };

  describe("constructor", () => {
    test("creates socket.io server on specified port", () => {
      const { server } = createServer({ port: 19999 });

      const io = server["_io"];
      expect(io).toBeDefined();
    });

    test("instantiates provider", () => {
      const { server } = createServer();

      const provider = server["_provider"];
      expect(provider).toBeDefined();
    });
  });

  describe("client connection", () => {
    test("accepts client connections", async () => {
      const { port } = createServer();

      const client = await connectClient(port);

      expect(client.connected).toBe(true);
    });
  });

  describe("event handlers", () => {
    test("get-doc returns null (doc not found)", async () => {
      const { port } = createServer();
      const client = await connectClient(port);

      const response = await client.emitWithAck("get-doc", {
        docId: "doc-123",
      });

      // socket.io serializes undefined as null
      expect(response).toBeNull();
    });

    test("sync-operations calls provider.sync", async () => {
      const { port, syncSpy } = createServer();
      const client = await connectClient(port);

      await client.emitWithAck("sync-operations", {
        docId: "doc-123",
        operations: [{ op: "insert" }],
        clock: 5,
      });

      expect(syncSpy).toHaveBeenCalledWith({
        docId: "doc-123",
        operations: [{ op: "insert" }],
        clock: 5,
      });
    });

    test("sync-operations returns provider result", async () => {
      const { port } = createServer();
      const client = await connectClient(port);

      const response = await client.emitWithAck("sync-operations", {
        docId: "doc-123",
        operations: null,
        clock: 10,
      });

      expect(response).toEqual({
        docId: "doc-123",
        operations: null,
        serializedDoc: { content: "synced" },
        clock: 11,
      });
    });

    test("delete-doc returns success", async () => {
      const { port } = createServer();
      const client = await connectClient(port);

      const response = await client.emitWithAck("delete-doc", {
        docId: "doc-123",
      });

      expect(response).toEqual({ success: true });
    });
  });
});
