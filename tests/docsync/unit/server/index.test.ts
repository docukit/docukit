// Server unit tests - run in Node process for coverage
// (integration tests run server in globalSetup, excluded from coverage)

import { describe, it, expect } from "vitest";
import { InMemoryServerProvider } from "@docnode/docsync/testing";
import {
  createServer,
  connect,
  connectAnonymous,
  waitForConnect,
  waitForError,
  syncOperations,
} from "./utils.js";

describe("DocSyncServer", () => {
  describe("authentication", () => {
    it("rejects without token", async () => {
      createServer();
      const error = await waitForError(connectAnonymous());
      expect(error.message).toContain("no token provided");
    });

    it("rejects invalid token", async () => {
      createServer();
      const error = await waitForError(connect("bad-token"));
      expect(error.message).toContain("invalid token");
    });

    it("accepts valid token", async () => {
      createServer();
      const socket = connect("valid-user1");
      await waitForConnect(socket);
      expect(socket.connected).toBe(true);
    });
  });

  describe("sync-operations", () => {
    it("returns incremented clock", async () => {
      createServer();
      const socket = connect("valid-user1");
      await waitForConnect(socket);

      const res = await syncOperations(socket, {
        docId: "doc-1",
        operations: [{ type: "insert" }],
        clock: 0,
      });

      expect(res).toMatchObject({ docId: "doc-1", clock: 1 });
    });
  });
});

describe("InMemoryServerProvider", () => {
  it("stores and retrieves operations by clock", async () => {
    const provider = new InMemoryServerProvider();
    const sync = (ops: unknown[] | null, clock: number) =>
      provider.sync({ docId: "doc-1", operations: ops, clock });

    // Client sends operation → clock increments
    expect(await sync([{ type: "op1" }], 0)).toMatchObject({
      clock: 1,
      operations: null,
    });

    // Another client at clock 0 → receives the operation
    expect(await sync(null, 0)).toMatchObject({
      clock: 1,
      operations: [{ type: "op1" }],
    });

    // Client at clock 1 → no new operations
    expect(await sync(null, 1)).toMatchObject({ operations: null });
  });
});
