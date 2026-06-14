import { tick } from "./async.js";
import type { TestClient } from "./client.js";

export const reconnectTestClient = async (testClient: TestClient) => {
  const connected = new Promise<void>((resolve) => {
    const off = testClient.docSync.on("connect", () => {
      off();
      resolve();
    });
  });

  testClient.docSync.disconnect();
  await tick();
  testClient.docSync.connect();
  await connected;
};

export const disconnectTestClient = async (testClient: TestClient) => {
  const disconnected = new Promise<void>((resolve) => {
    const off = testClient.docSync.on("disconnect", () => {
      off();
      resolve();
    });
  });

  testClient.docSync.disconnect();
  await disconnected;
};
