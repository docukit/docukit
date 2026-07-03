import { describe, expect, inject, test } from "vitest";
import {
  DocSyncClient,
  indexedDBProvider,
  type ClientAuthConfig,
} from "@docukit/docsync2/client";
import { DocNodeBinding } from "@docukit/docsync2/docnode";
import { createTestDocArgs } from "../client/utils/generators.js";
import { TestNode } from "../client/utils/client.js";

const LOCAL_IDENTITY_KEY = "docsync:localUserId";

const testServerUrl = () => {
  const injectedPort: number | undefined = inject("docsync2TestServerPort");
  const port = injectedPort ?? globalThis.__DOCSYNC2_TEST_SERVER_PORT__ ?? 8083;
  return `ws://localhost:${port}`;
};

const createClient = ({ auth }: { auth: ClientAuthConfig }) => {
  const docArgs = createTestDocArgs();
  return new DocSyncClient({
    docBinding: DocNodeBinding([
      { type: docArgs.type, extensions: [{ nodes: [TestNode] }] },
    ]),
    server: { url: testServerUrl(), auth },
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

describe("DocSync2 authentication", () => {
  test("request auth can authenticate from the handshake request", async () => {
    const userId = "docsync2-request-user";
    localStorage.removeItem(LOCAL_IDENTITY_KEY);
    const client = createClient({ auth: { mode: "request" } });

    try {
      await waitForConnection(client["_socket"]);
      await expect
        .poll(() => localStorage.getItem(LOCAL_IDENTITY_KEY))
        .toBe(userId);
    } finally {
      client.disconnect();
      client.dispose();
    }
  });

  test("cached local identity must match the authenticated server identity", async () => {
    localStorage.setItem(LOCAL_IDENTITY_KEY, "wrong-user");
    const client = createClient({
      auth: { mode: "token", getToken: () => "test-token-right-user" },
    });

    try {
      const error = await new Promise<Error>((resolve) => {
        client["_socket"].once("connect_error", resolve);
      });
      expect(error.message).toContain("claimed user ID mismatch");
    } finally {
      client.disconnect();
      client.dispose();
      localStorage.removeItem(LOCAL_IDENTITY_KEY);
    }
  });
});
