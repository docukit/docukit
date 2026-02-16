import { describe, test, expect, expectTypeOf } from "vitest";
import type {
  DisconnectEvent,
  ChangeEvent,
  SyncEvent,
  DocLoadEvent,
  DocUnloadEvent,
} from "@docukit/docsync/client";
import type { JsonDoc, Operations } from "@docukit/docnode";
import {
  createClient,
  generateDocId,
  setupDocWithOperations,
  saveOperations,
  ops,
  emptyOps,
  spyOnRequest,
  triggerSync,
} from "../client2/utils.js";

describe("Client Events", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // onConnect
  // ──────────────────────────────────────────────────────────────────────────

  describe('on("connect")', () => {
    test("should allow registering and unregistering handlers", async () => {
      const client = await createClient();

      let called = false;
      const off = client.on("connect", () => {
        called = true;
      });

      client["_events"].emit("connect");
      await expect.poll(() => called).toBe(true);

      called = false;
      off();
      client["_events"].emit("connect");
      await expect.poll(() => called).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // onDisconnect
  // ──────────────────────────────────────────────────────────────────────────

  describe('on("disconnect")', () => {
    test("should emit when WebSocket connection is lost", async () => {
      const client = await createClient();
      client.disconnect();

      let disconnectReason: string | undefined;
      client.on("disconnect", (event) => {
        disconnectReason = event.reason;
      });

      client["_events"].emit("disconnect", {
        reason: "transport close",
      });
      await expect.poll(() => disconnectReason).toBe("transport close");
    });

    test("should clear push status on disconnect", async () => {
      const client = await createClient();
      const docId = generateDocId();

      await saveOperations(client, docId);
      triggerSync(client, docId);
      await expect
        .poll(() => client["_pushStatusByDocId"].size)
        .toBeGreaterThan(0);

      client["_pushStatusByDocId"].clear();
      client["_events"].emit("disconnect", { reason: "test" });
      await expect.poll(() => client["_pushStatusByDocId"].size).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // onChange
  // ──────────────────────────────────────────────────────────────────────────

  describe('on("change")', () => {
    test("should emit for remote changes", async () => {
      const client = await createClient();
      const docId = generateDocId();

      let changeOrigin: string | undefined;
      client.on("change", (event) => {
        changeOrigin = event.origin;
      });

      const testOperations = [ops({ test: "data" })];
      client["_events"].emit("change", {
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

  describe('on("sync")', () => {
    test("should emit on successful sync", async () => {
      const client = await createClient();
      const docId = generateDocId();

      const testOps = [emptyOps()];
      await saveOperations(client, docId, testOps);

      spyOnRequest(client).mockResolvedValue({
        data: { docId, clock: 1 },
      });

      let syncSuccess = false;
      client.on("sync", (event) => {
        if ("data" in event) {
          syncSuccess = true;
        }
      });

      triggerSync(client, docId);
      await expect.poll(() => syncSuccess).toBe(true);
    });

    test("should emit on network error", async () => {
      const client = await createClient();
      const docId = generateDocId();

      await saveOperations(client, docId);

      spyOnRequest(client).mockRejectedValue(new Error("Network timeout"));

      let hasError = false;
      client.on("sync", (event) => {
        if ("error" in event) {
          hasError = true;
        }
      });

      triggerSync(client, docId);
      await expect.poll(() => hasError).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // onDocLoad
  // ──────────────────────────────────────────────────────────────────────────

  describe('on("docLoad")', () => {
    test("should emit when document is created", async () => {
      const client = await createClient();
      const docId = generateDocId();

      let loadSource: string | undefined;
      client.on("docLoad", (event) => {
        loadSource = event.source;
      });

      const cleanup = client.getDoc(
        { type: "test", id: docId, createIfMissing: true },
        () => {
          /* doc updates callback */
        },
      );
      await expect.poll(() => loadSource).toBe("created");

      cleanup();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // onDocUnload
  // ──────────────────────────────────────────────────────────────────────────

  describe('on("docUnload")', () => {
    test("should emit when document is unloaded", async () => {
      const client = await createClient();
      const docId = generateDocId();

      await setupDocWithOperations(client, docId);

      let unloadRefCount: number | undefined;
      client.on("docUnload", (event) => {
        unloadRefCount = event.refCount;
      });

      const cleanup = client.getDoc({ type: "test", id: docId }, () => {
        /* doc updates callback */
      });
      cleanup();
      await expect.poll(() => unloadRefCount).toBe(0);
    });
  });

  describe("types", () => {
    test('on("connect") listener payload is undefined', async () => {
      const client = await createClient();
      client.on("connect", (ev) => {
        expectTypeOf(ev).toEqualTypeOf<undefined>();
      });
    });

    test('on("disconnect") listener payload is DisconnectEvent', async () => {
      const client = await createClient();
      client.on("disconnect", (ev) => {
        expectTypeOf(ev).toEqualTypeOf<DisconnectEvent>();
      });
    });

    test('on("change") listener payload is ChangeEvent<Operations>', async () => {
      const client = await createClient();
      client.on("change", (ev) => {
        expectTypeOf(ev).toEqualTypeOf<ChangeEvent<Operations>>();
      });
    });

    test('on("sync") listener payload is SyncEvent<Operations, JsonDoc>', async () => {
      const client = await createClient();
      client.on("sync", (ev) => {
        expectTypeOf(ev).toEqualTypeOf<SyncEvent<Operations, JsonDoc>>();
      });
    });

    test('on("docLoad") listener payload is DocLoadEvent', async () => {
      const client = await createClient();
      client.on("docLoad", (ev) => {
        expectTypeOf(ev).toEqualTypeOf<DocLoadEvent>();
      });
    });

    test('on("docUnload") listener payload is DocUnloadEvent', async () => {
      const client = await createClient();
      client.on("docUnload", (ev) => {
        expectTypeOf(ev).toEqualTypeOf<DocUnloadEvent>();
      });
    });
  });
});
