import { describe, test, expect, vi } from "vitest";
import { DocSyncClient } from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { defineNode } from "docnode";
import { ulid } from "ulid";
import {
  TestNode,
  createClient,
  createCallback,
  tick,
  getSuccessData,
} from "./utils.js";

// Mock socket.io-client to avoid real connections
vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

// ============================================================================
// DocSyncClient Tests
// ============================================================================

describe("DocSyncClient", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // Constructor tests
  // ──────────────────────────────────────────────────────────────────────────

  describe("constructor", () => {
    test("should throw error when duplicate type is provided", () => {
      const DuplicateNode = defineNode({ type: "test", state: {} });

      expect(() =>
        DocNodeBinding([
          { type: "test", extensions: [{ nodes: [TestNode] }] },
          { type: "test", extensions: [{ nodes: [DuplicateNode] }] },
        ]),
      ).toThrow("Duplicate doc type: test");
    });

    test("should initialize with valid config", () => {
      const client = createClient();
      expect(client).toBeInstanceOf(DocSyncClient);
    });

    test("should initialize with local provider config", () => {
      const client = createClient(true);
      expect(client).toBeInstanceOf(DocSyncClient);
    });

    test("should set up BroadcastChannel for cross-tab communication", () => {
      const originalBroadcastChannel = globalThis.BroadcastChannel;
      const constructorSpy = vi.fn();

      // Mock BroadcastChannel as a class
      class MockBroadcastChannel {
        onmessage: ((ev: MessageEvent) => void) | null = null;
        constructor(name: string) {
          constructorSpy(name);
        }
        postMessage = vi.fn();
        close = vi.fn();
      }

      globalThis.BroadcastChannel =
        MockBroadcastChannel as unknown as typeof BroadcastChannel;

      try {
        const client = createClient();
        expect(constructorSpy).toHaveBeenCalledWith("docsync");
        expect(client).toBeInstanceOf(DocSyncClient);
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // getDoc tests
  // ──────────────────────────────────────────────────────────────────────────

  describe("getDoc", () => {
    describe("Get existing document", () => {
      test("should emit loading status initially", () => {
        const client = createClient(true);
        const callback = createCallback();

        client.getDoc({ type: "test", id: "test-id" }, callback);

        expect(callback).toHaveBeenCalledWith({
          status: "loading",
          data: undefined,
          error: undefined,
        });
      });

      test("should return undefined when document does not exist and createIfMissing is false", async () => {
        const client = createClient(true);
        const callback = createCallback();

        client.getDoc({ type: "test", id: "non-existent-id" }, callback);
        await tick();

        expect(callback).toHaveBeenLastCalledWith({
          status: "success",
          data: undefined,
          error: undefined,
        });
      });

      test("should return cached document when requested multiple times", async () => {
        const client = createClient(true);
        const callback1 = createCallback();
        const callback2 = createCallback();

        // Create a doc first
        client.getDoc({ type: "test", createIfMissing: true }, callback1);
        await tick();
        const createdDoc = getSuccessData(callback1);
        expect(createdDoc).toBeDefined();

        // Request the same doc again
        client.getDoc({ type: "test", id: createdDoc!.id }, callback2);
        await tick();
        const cachedDoc = getSuccessData(callback2);
        expect(cachedDoc?.doc).toBe(createdDoc!.doc);
      });
    });

    describe("Create new document", () => {
      test("should create new document with auto-generated ID when createIfMissing is true", () => {
        const client = createClient(true);
        const callback = createCallback();

        client.getDoc({ type: "test", createIfMissing: true }, callback);

        // Should immediately emit success (sync operation)
        expect(callback).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "success",
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            data: expect.objectContaining({
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              doc: expect.anything(),
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              id: expect.any(String),
            }),
          }),
        );
      });

      test("should generate unique IDs for each new document", () => {
        const client = createClient(true);
        const callback1 = createCallback();
        const callback2 = createCallback();

        client.getDoc({ type: "test", createIfMissing: true }, callback1);
        client.getDoc({ type: "test", createIfMissing: true }, callback2);

        const id1 = callback1.mock.calls[0]?.[0]?.data?.id;
        const id2 = callback2.mock.calls[0]?.[0]?.data?.id;

        expect(id1).toBeDefined();
        expect(id2).toBeDefined();
        expect(id1).not.toBe(id2);
      });

      test("should return unsubscribe function", () => {
        const client = createClient(true);
        const callback = createCallback();

        const unsubscribe = client.getDoc(
          { type: "test", createIfMissing: true },
          callback,
        );

        expect(typeof unsubscribe).toBe("function");
      });
    });

    describe("Get or create", () => {
      test("should create document with provided id when createIfMissing is true", async () => {
        const client = createClient(true);
        const callback = createCallback();
        const customId = ulid().toLowerCase();

        client.getDoc(
          { type: "test", id: customId, createIfMissing: true },
          callback,
        );
        await tick();

        expect(getSuccessData(callback)?.id).toBe(customId);
      });
    });
  });
});

// applyOperations tests
// "should apply operations to document when document exists in cache"
// "should do nothing when document does not exist in cache"
// "should set _shouldBroadcast to false before applying operations"

// _loadOrCreateDoc tests
// "should load document from provider when jsonDoc exists"
// "should parse type from loaded jsonDoc"
// "should create new document when jsonDoc does not exist and type is provided"
// "should return undefined when jsonDoc does not exist and type is not provided"
// "should throw error when type from jsonDoc is unknown"

// _unloadDoc tests
// "should decrement refCount when document has multiple references"
// "should remove document from cache when refCount reaches 0"
// "should clear change listeners when document is unloaded"
// "should clear normalize listeners when document is unloaded"
// "should do nothing when document does not exist in cache"

// onLocalOperations tests
// "should save operations to provider"
// "should set _inLocalWaiting when push is already in progress"
// "should push operations to server when not in progress"
// "should retry push when server returns error"
// "should delete operations from provider after successful push"
// "should save updated jsonDoc after successful push"
// "should push again if operations were queued during push"
// "should throw error when push is called while already in progress"

// _pushOperationsToServer tests
// "should emit push event to socket with operations"
// "should return error when server responds with error"
// "should return operations when server responds successfully"

// BroadcastChannel integration tests
// "should send OPERATIONS message to BroadcastChannel on document change"
// "should receive OPERATIONS message from BroadcastChannel and apply to document"
// "should ignore non-OPERATIONS messages from BroadcastChannel"

// Socket.io integration tests
// "should connect to socket.io server on initialization"
// "should handle socket connection errors"
// "should handle socket disconnection"
