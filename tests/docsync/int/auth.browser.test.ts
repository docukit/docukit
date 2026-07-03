// TODO: move to unit tests

import { describe, expect, inject, test } from "vitest";
import { DocSyncClient, indexedDBProvider } from "@docukit/docsync/client";
import { DocNodeBinding } from "@docukit/docsync/docnode";
import { defineNode, string } from "@docukit/docnode";

const LOCAL_IDENTITY_KEY = "docsync:localUserId";

const docBinding = DocNodeBinding([
  {
    type: "t",
    extensions: [
      { nodes: [defineNode({ type: "c", state: { v: string("") } })] },
    ],
  },
]);

const getTestServerUrl = () => {
  const injectedPort: number | undefined = inject("testServerPort");
  const port = injectedPort ?? globalThis.__TEST_SERVER_PORT__ ?? 8082;
  return `ws://localhost:${port}`;
};

const createClient = (token: string) => {
  localStorage.removeItem(LOCAL_IDENTITY_KEY);

  return new DocSyncClient({
    server: {
      url: getTestServerUrl(),
      auth: { mode: "token", getToken: () => token },
    },
    docBinding,
    local: { provider: indexedDBProvider },
  });
};

const waitForConnection = (socket: {
  once(event: "connect", listener: () => void): unknown;
  once(event: "connect_error", listener: (error: Error) => void): unknown;
}) =>
  new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });

describe("Authentication", () => {
  test("client with valid token connects successfully", async () => {
    const client = createClient("test-token-user1");
    const socket = client["_socket"];
    await waitForConnection(socket);
    socket.disconnect();
  });

  test("client with invalid token is rejected", async () => {
    const client = createClient("invalid");
    const socket = client["_socket"];
    const error = await new Promise<Error>((r) =>
      socket.once("connect_error", r),
    );
    expect(error.message).toContain("Authentication");
    socket.disconnect();
  });
});
