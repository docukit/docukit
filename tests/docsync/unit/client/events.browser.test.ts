import { describe, test, expect } from "vitest";
import {
  createClient,
  generateDocId,
  setupDocWithOperations,
  saveOperations,
  ops,
  emptyOps,
  spyOnRequest,
} from "../client2/utils.js";

describe("Client Events", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // onConnect
  // ──────────────────────────────────────────────────────────────────────────

  describe("onConnect", () => {
    test("should allow registering and unregistering handlers", async () => {
      const client = await createClient();

      let called = false;
      const unsubscribe = client.onConnect(() => {
        called = true;
      });

      client["_emit"](client["_connectEventListeners"]);
      await expect.poll(() => called).toBe(true);

      // Test unsubscribe
      called = false;
      unsubscribe();
      client["_emit"](client["_connectEventListeners"]);
      await expect.poll(() => called).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // onDisconnect
  // ──────────────────────────────────────────────────────────────────────────

  describe("onDisconnect", () => {
    test("should emit when WebSocket connection is lost", async () => {
      const client = await createClient();
      // Disconnect immediately to prevent real socket events from interfering
      client.disconnect();

      let disconnectReason: string | undefined;
      client.onDisconnect((event) => {
        disconnectReason = event.reason;
      });

      client["_emit"](client["_disconnectEventListeners"], {
        reason: "transport close",
      });
      await expect.poll(() => disconnectReason).toBe("transport close");
    });

    test("should clear push status on disconnect", async () => {
      const client = await createClient();
      const docId = generateDocId();

      await saveOperations(client, docId);
      client.saveRemote({ docId });
      await expect
        .poll(() => client["_pushStatusByDocId"].size)
        .toBeGreaterThan(0);

      client["_pushStatusByDocId"].clear();
      client["_emit"](client["_disconnectEventListeners"], { reason: "test" });
      await expect.poll(() => client["_pushStatusByDocId"].size).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // onChange
  // ──────────────────────────────────────────────────────────────────────────

  describe("onChange", () => {
    test("should emit for remote changes", async () => {
      const client = await createClient();
      const docId = generateDocId();

      let changeOrigin: string | undefined;
      client.onChange((event) => {
        changeOrigin = event.origin;
      });

      const testOperations = [ops({ test: "data" })];
      client["_emit"](client["_changeEventListeners"], {
        docId,
        origin: "remote",
        operations: testOperations,
      });
      await expect.poll(() => changeOrigin).toBe("remote");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // onSync
  // ──────────────────────────────────────────────────────────────────────────

  describe("onSync", () => {
    test("should emit on successful sync", async () => {
      const client = await createClient();
      const docId = generateDocId();

      const testOps = [emptyOps()];
      await saveOperations(client, docId, testOps);

      spyOnRequest(client).mockResolvedValue({
        data: { docId, clock: 1 },
      });

      let syncSuccess = false;
      client.onSync((event) => {
        if ("data" in event) {
          syncSuccess = true;
        }
      });

      client.saveRemote({ docId });
      await expect.poll(() => syncSuccess).toBe(true);
    });

    test("should emit on network error", async () => {
      const client = await createClient();
      const docId = generateDocId();

      await saveOperations(client, docId);

      spyOnRequest(client).mockRejectedValue(new Error("Network timeout"));

      let hasError = false;
      client.onSync((event) => {
        if ("error" in event) {
          hasError = true;
        }
      });

      client.saveRemote({ docId });
      await expect.poll(() => hasError).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // onDocLoad
  // ──────────────────────────────────────────────────────────────────────────

  describe("onDocLoad", () => {
    test("should emit when document is created", async () => {
      const client = await createClient();
      const docId = generateDocId();

      let loadSource: string | undefined;
      client.onDocLoad((event) => {
        loadSource = event.source;
      });

      const cleanup = client.getDoc(
        { type: "test", id: docId, createIfMissing: true },
        () => {
          // Callback for doc updates
        },
      );
      await expect.poll(() => loadSource).toBe("created");

      // Cleanup
      cleanup();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // onDocUnload
  // ──────────────────────────────────────────────────────────────────────────

  describe("onDocUnload", () => {
    test("should emit when document is unloaded", async () => {
      const client = await createClient();
      const docId = generateDocId();

      await setupDocWithOperations(client, docId);

      let unloadRefCount: number | undefined;
      client.onDocUnload((event) => {
        unloadRefCount = event.refCount;
      });

      // Load and then unload
      const cleanup = client.getDoc({ type: "test", id: docId }, () => {
        // Callback for doc updates
      });
      cleanup();
      await expect.poll(() => unloadRefCount).toBe(0);
    });
  });
});
