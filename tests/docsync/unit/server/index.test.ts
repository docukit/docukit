// Server unit tests - run in Node process for coverage
// (integration tests run server in globalSetup, excluded from coverage)

import { describe, test, expect } from "vitest";
import { testWrapper } from "./utils.js";

describe("authentication", () => {
  test("rejects without token", async () => {
    const auth = { getToken: async () => "" };
    await testWrapper({ auth }, async (T) => {
      const error = await T.waitForError();
      expect(error.message).toContain("no token provided");
    });
  });

  test("rejects invalid token0", async () => {
    const auth = { getToken: async () => "test-token" };
    await testWrapper({ auth }, async (T) => {
      const error = await T.waitForError();
      expect(error.message).toContain("invalid token");
    });
  });

  test("accepts valid token", async () => {
    const auth = { getToken: async () => "valid-user1" };
    await testWrapper({ auth }, async (T) => {
      await T.waitForConnect();
      expect(T.socket.connected).toBe(true);
    });
  });
});

describe("sync-operations", () => {
  test("returns incremented clock", async () => {
    const auth = { getToken: async () => "valid-user1" };
    await testWrapper({ auth }, async (T) => {
      await T.waitForConnect();
      expect(T.socket.connected).toBe(true);
      const res = await T.syncOperations({
        docId: "doc-1",
        operations: [{ type: "insert" }],
        clock: 0,
      });

      expect(res).toMatchObject({ docId: "doc-1", clock: 1 });
    });
  });
});
