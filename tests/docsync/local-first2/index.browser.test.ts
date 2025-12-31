import { describe, test, expect, afterEach } from "vitest";
import { setupClients, type ClientsSetup } from "./utils.js";

describe("Local-First 2.0", () => {
  const activeClients: ClientsSetup[] = [];

  afterEach(async () => {
    // Clean up all docs
    for (const clients of activeClients) {
      clients.reference.unLoadDoc();
      clients.otherTab.unLoadDoc();
      clients.otherTabAndUser.unLoadDoc();
      clients.otherDevice.unLoadDoc();

      // Close sockets
      const allClients = [
        clients.reference.client,
        clients.otherTab.client,
        clients.otherTabAndUser.client,
        clients.otherDevice.client,
      ];

      for (const client of allClients) {
        /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/dot-notation */
        // Close socket if exists
        const serverSync = (client as any)["_serverSync"];
        if (serverSync) {
          const socket = serverSync["_api"]["_socket"];
          if (socket?.connected) {
            socket.disconnect();
          }
        }
        // Close broadcast channel if exists
        const bc = (client as any)["_broadcastChannel"];
        if (bc) {
          bc.close();
        }
        /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/dot-notation */
      }
    }
    activeClients.length = 0;

    // Give time for cleanup to complete
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  test("setupClients creates 4 clients with correct configuration", async () => {
    const clients = await setupClients();
    activeClients.push(clients);

    // Verify docId is shared
    expect(clients.docId).toBeDefined();

    // Verify all clients exist
    expect(clients.reference.client).toBeDefined();
    expect(clients.otherTab.client).toBeDefined();
    expect(clients.otherTabAndUser.client).toBeDefined();
    expect(clients.otherDevice.client).toBeDefined();

    // Verify initial state
    expect(clients.reference.doc).toBeUndefined();
    expect(clients.otherTab.doc).toBeUndefined();
    expect(clients.otherTabAndUser.doc).toBeUndefined();
    expect(clients.otherDevice.doc).toBeUndefined();
  });

  test("reference can load and add child", async () => {
    const clients = await setupClients();
    activeClients.push(clients);

    await clients.reference.loadDoc();
    expect(clients.reference.doc).toBeDefined();
    expect(clients.reference.doc!.root).toBeDefined();

    // Add a child
    clients.reference.addChild("Hello");

    // Verify in memory
    clients.reference.assertMemoryDoc(["Hello"]);

    // Wait for IndexedDB sync
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Verify in IndexedDB
    await clients.reference.assertIDBDoc(["Hello"]);
  });
});
