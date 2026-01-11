// Server unit tests - run in Node process for coverage
// (integration tests run server in globalSetup, excluded from coverage)

import { describe, it, expect } from "vitest";
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
