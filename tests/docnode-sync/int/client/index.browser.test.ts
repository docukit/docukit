import { describe, test, expect, vi, expectTypeOf } from "vitest";
import {
  DocSyncClient,
  type DocData,
  type QueryResult,
} from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { defineNode, type Doc } from "docnode";
import { ulid } from "ulid";
import {
  TestNode,
  ChildNode,
  createClient,
  createClientWithRemoveListenersSpy,
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
  // Type tests
  // ──────────────────────────────────────────────────────────────────────────

  describe("getDoc types", () => {
    type DocResult = QueryResult<DocData<Doc>>;
    type MaybeDocResult = QueryResult<DocData<Doc> | undefined>;

    // These tests only verify types at compile time, no runtime assertions needed
    test("callback receives correct types based on args", () => {
      const client = createClient(true);
      const id = ulid().toLowerCase();

      // with id, without createIfMissing → MaybeDocResult
      client.getDoc({ type: "test", id }, (result) => {
        expectTypeOf(result).toEqualTypeOf<MaybeDocResult>();
      });

      // with id, createIfMissing: true → DocResult
      client.getDoc({ type: "test", id, createIfMissing: true }, (result) => {
        expectTypeOf(result).toEqualTypeOf<DocResult>();
      });

      // without id, createIfMissing: true → DocResult
      client.getDoc({ type: "test", createIfMissing: true }, (result) => {
        expectTypeOf(result).toEqualTypeOf<DocResult>();
      });

      // with id, createIfMissing: false → MaybeDocResult
      client.getDoc({ type: "test", id, createIfMissing: false }, (result) => {
        expectTypeOf(result).toEqualTypeOf<MaybeDocResult>();
      });
    });

    test("type errors for invalid arguments", () => {
      // These are compile-time checks only - we use a function that's never called
      // to avoid runtime execution while still getting TypeScript to check the types
      const typeCheck = (client: ReturnType<typeof createClient>) => {
        const callback = createCallback();

        // @ts-expect-error - type is required (even with id)
        client.getDoc({ id: "123" }, callback);

        // @ts-expect-error - type is required (even with createIfMissing and id)
        client.getDoc({ createIfMissing: true, id: "123" }, callback);

        // @ts-expect-error - without id, createIfMissing must be true
        client.getDoc({ type: "test" }, callback);

        // @ts-expect-error - without id, createIfMissing: false is invalid
        client.getDoc({ type: "test", createIfMissing: false }, callback);
      };

      // Verify the function exists (never called, just for type checking)
      expect(typeCheck).toBeDefined();
    });

    test("QueryResult has expected structure", () => {
      expectTypeOf<DocResult>().toEqualTypeOf<
        | {
            status: "loading";
            data: undefined;
            error: undefined;
          }
        | {
            status: "success";
            data: DocData<Doc>;
            error: undefined;
          }
        | {
            status: "error";
            data: undefined;
            error: Error;
          }
      >();
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

    describe("Sync vs async behavior", () => {
      test("should NOT emit loading when creating new doc without id", () => {
        const client = createClient(true);
        const callback = createCallback();

        client.getDoc({ type: "test", createIfMissing: true }, callback);

        // First call should be success, not loading
        expect(callback.mock.calls[0]?.[0]?.status).toBe("success");
        expect(callback).toHaveBeenCalledTimes(1);
      });

      test("should emit loading before success when fetching by id", async () => {
        const client = createClient(true);
        const callback = createCallback();
        const customId = ulid().toLowerCase();

        client.getDoc({ type: "test", id: customId }, callback);

        // First call should be loading
        expect(callback.mock.calls[0]?.[0]?.status).toBe("loading");

        await tick();

        // Second call should be success
        expect(callback.mock.calls[1]?.[0]?.status).toBe("success");
      });
    });

    describe("Unsubscribe", () => {
      test("should remove doc from cache and call removeListeners when last subscriber unsubscribes", async () => {
        const { client, removeListenersSpy } =
          createClientWithRemoveListenersSpy(true);
        const callback = createCallback();

        const unsubscribe = client.getDoc(
          { type: "test", createIfMissing: true },
          callback,
        );
        const doc = getSuccessData(callback)!.doc;
        const docId = getSuccessData(callback)!.id;
        const cache = client["_docsCache"];

        expect(cache.has(docId)).toBe(true);
        expect(cache.get(docId)?.refCount).toBe(1);
        expect(removeListenersSpy).not.toHaveBeenCalled();

        unsubscribe();
        await tick(); // _unloadDoc is async

        expect(cache.has(docId)).toBe(false);
        expect(removeListenersSpy).toHaveBeenCalledOnce();
        expect(removeListenersSpy).toHaveBeenCalledWith(doc);
      });

      test("should NOT call removeListeners when non-last subscriber unsubscribes", async () => {
        const { client, removeListenersSpy } =
          createClientWithRemoveListenersSpy(true);
        const callback1 = createCallback();
        const callback2 = createCallback();

        // First subscription creates the doc
        const unsubscribe1 = client.getDoc(
          { type: "test", createIfMissing: true },
          callback1,
        );
        const doc = getSuccessData(callback1)!.doc;
        const docId = getSuccessData(callback1)!.id;

        // Second subscription to same doc
        const unsubscribe2 = client.getDoc(
          { type: "test", id: docId },
          callback2,
        );
        await tick();

        const cache = client["_docsCache"];
        expect(cache.get(docId)?.refCount).toBe(2);

        // Unsubscribe first one - should NOT call removeListeners
        unsubscribe1();
        await tick();

        expect(cache.get(docId)?.refCount).toBe(1);
        expect(cache.has(docId)).toBe(true);
        expect(removeListenersSpy).not.toHaveBeenCalled();

        // Unsubscribe second one - should call removeListeners
        unsubscribe2();
        await tick();

        expect(cache.has(docId)).toBe(false);
        expect(removeListenersSpy).toHaveBeenCalledOnce();
        expect(removeListenersSpy).toHaveBeenCalledWith(doc);
      });
    });

    describe("refCount / multiple subscriptions", () => {
      test("should increment refCount for each subscription to same doc", async () => {
        const client = createClient(true);
        const callback1 = createCallback();
        const callback2 = createCallback();
        const callback3 = createCallback();

        // Create doc
        client.getDoc({ type: "test", createIfMissing: true }, callback1);
        const docId = getSuccessData(callback1)!.id;

        const cache = client["_docsCache"];
        expect(cache.get(docId)?.refCount).toBe(1);

        // Second subscription
        client.getDoc({ type: "test", id: docId }, callback2);
        await tick();
        expect(cache.get(docId)?.refCount).toBe(2);

        // Third subscription
        client.getDoc({ type: "test", id: docId }, callback3);
        await tick();
        expect(cache.get(docId)?.refCount).toBe(3);
      });

      test("should share same doc instance across multiple subscriptions", async () => {
        const client = createClient(true);
        const callback1 = createCallback();
        const callback2 = createCallback();

        // Create doc
        client.getDoc({ type: "test", createIfMissing: true }, callback1);
        const doc1 = getSuccessData(callback1)!.doc;

        // Second subscription
        client.getDoc(
          { type: "test", id: getSuccessData(callback1)!.id },
          callback2,
        );
        await tick();
        const doc2 = getSuccessData(callback2)!.doc;

        // Same instance
        expect(doc1).toBe(doc2);
      });

      test("should NOT notify callback when document content changes", async () => {
        const client = createClient(true);
        const callback = createCallback();

        // Create doc
        client.getDoc({ type: "test", createIfMissing: true }, callback);
        const doc = getSuccessData(callback)!.doc;

        // Initial call count (1 for success)
        expect(callback.mock.calls.length).toBe(1);

        // Trigger a document change
        doc.root.append(doc.createNode(ChildNode));
        await tick(); // Changes are committed in a microtask

        // Callback should NOT be called on doc changes
        // User observes doc changes via doc.onChange() directly
        expect(callback.mock.calls.length).toBe(1);
      });
    });

    describe("Concurrency", () => {
      test("should share promise when multiple requests for same doc happen simultaneously", async () => {
        const client = createClient(true);
        const callback1 = createCallback();
        const callback2 = createCallback();
        const customId = ulid().toLowerCase();

        // Two simultaneous requests for the same non-existent doc
        client.getDoc(
          { type: "test", id: customId, createIfMissing: true },
          callback1,
        );
        client.getDoc(
          { type: "test", id: customId, createIfMissing: true },
          callback2,
        );

        await tick();

        // Both should get the same doc instance
        const doc1 = getSuccessData(callback1)?.doc;
        const doc2 = getSuccessData(callback2)?.doc;

        expect(doc1).toBeDefined();
        expect(doc1).toBe(doc2);

        // refCount should be 2
        const cache = client["_docsCache"];
        expect(cache.get(customId)?.refCount).toBe(2);
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
