import { afterEach, describe, expect, test } from "vitest";
import { io, type Socket } from "socket.io-client";
import { DocNodeValidators } from "@docukit/docsync2/docnode";
import {
  DocSyncServer,
  inMemoryServerProvider,
  type DocSubscribeEvent,
  type DocUnsubscribeEvent,
} from "@docukit/docsync2/server";
import type { JsonDoc, Operations } from "@docukit/docnode";

const BASE_PORT = (() => {
  const poolId = Number.parseInt(process.env.VITEST_POOL_ID ?? "1", 10);
  return 10888 + (poolId - 1) * 100;
})();

const testPort = (offset = 0) => BASE_PORT + offset;

const servers: DocSyncServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.disconnect();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

const createServer = (port: number) => {
  const server = new DocSyncServer({
    validators: DocNodeValidators(),
    port,
    provider: inMemoryServerProvider<JsonDoc, Operations>(),
    authenticate: ({ token }) => {
      if (!token) return undefined;
      return { userId: token };
    },
  });
  servers.push(server);
  return server;
};

const connectSocket = async (port: number) => {
  const socket = io(`ws://localhost:${port}`, {
    auth: {
      token: "user-1",
      deviceId: "device-1",
      clientId: "client-1",
      claimedUserId: null,
    },
    transports: ["websocket"],
  });
  sockets.push(socket);

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });

  return socket;
};

describe("DocSync2 server events", () => {
  test("emits document subscribe and unsubscribe events", async () => {
    const port = testPort();
    const server = createServer(port);
    const subscribeEvents: DocSubscribeEvent[] = [];
    const unsubscribeEvents: DocUnsubscribeEvent[] = [];

    server.onDocSubscribe((event) => {
      subscribeEvents.push(event);
    });
    server.onDocUnsubscribe((event) => {
      unsubscribeEvents.push(event);
    });

    const socket = await connectSocket(port);
    const docId = "doc-1";

    await new Promise<void>((resolve) => {
      socket.emit(
        "sync",
        { type: "test", docId, operations: [], clock: 0 },
        () => resolve(),
      );
    });

    expect(subscribeEvents).toStrictEqual([
      { userId: "user-1", deviceId: "device-1", clientId: "client-1", docId },
    ]);

    await new Promise<void>((resolve) => {
      socket.emit("unsubscribe-doc", { docId }, () => resolve());
    });

    expect(unsubscribeEvents).toStrictEqual([
      {
        userId: "user-1",
        deviceId: "device-1",
        clientId: "client-1",
        docId,
        reason: "unsubscribe-doc",
      },
    ]);
  });
});
