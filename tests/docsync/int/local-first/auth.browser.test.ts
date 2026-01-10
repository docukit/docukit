import { describe, test, expect, vi } from "vitest";
import { DocSyncClient, IndexedDBProvider } from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { defineNode, string } from "docnode";

const docBinding = DocNodeBinding([
  {
    type: "t",
    extensions: [
      { nodes: [defineNode({ type: "c", state: { v: string("") } })] },
    ],
  },
]);

const url = `ws://localhost:${globalThis.__TEST_SERVER_PORT__ ?? 8082}`;

const createClient = (token: string) =>
  new DocSyncClient({
    server: { url, auth: { getToken: async () => token } },
    docBinding,
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({ userId: "u", secret: "s" }),
    },
  });

describe("Authentication", () => {
  test("client with valid token connects successfully", async () => {
    const client = createClient("test-token-user1");
    const socket = client["_serverSync"]["_api"]["_socket"];
    await vi.waitFor(() => expect(socket.connected).toBe(true), {
      timeout: 500,
    });
    socket.disconnect();
  });

  test("client with invalid token is rejected", async () => {
    const client = createClient("invalid");
    const socket = client["_serverSync"]["_api"]["_socket"];
    const error = await new Promise<Error>((r) =>
      socket.on("connect_error", r),
    );
    expect(error.message).toContain("Authentication");
    socket.disconnect();
  });
});
