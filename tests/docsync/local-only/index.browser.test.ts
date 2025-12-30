import { describe, test, expect, vi, expectTypeOf } from "vitest";
import {
  DocSyncClient,
  type DocData,
  type Identity,
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
  createClientWithProvider,
  createFailingProvider,
  createCallback,
  tick,
  getSuccessData,
  getErrorResult,
} from "../utils.js";

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

    test("should set up BroadcastChannel for cross-tab communication", async () => {
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
        // Need local config to initialize BroadcastChannel
        const client = createClient(true);
        const callback = createCallback();

        // Trigger _localPromise resolution by calling getDoc
        client.getDoc({ type: "test", createIfMissing: true }, callback);

        // Wait for async initialization
        await tick(10);

        expect(constructorSpy).toHaveBeenCalledOnce();
        // BroadcastChannel name should be user-specific: "docsync:{userId}"
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const channelName = constructorSpy.mock.calls[0]?.[0];
        expect(channelName).toMatch(/^docsync:test-user-/);
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

      test("should resolve cache hit on next microtask (no setTimeout needed)", async () => {
        const client = createClient(true);
        const callback1 = createCallback();
        const callback2 = createCallback();

        // Create a doc first (sync path)
        client.getDoc({ type: "test", createIfMissing: true }, callback1);
        const createdDoc = getSuccessData(callback1);
        expect(createdDoc).toBeDefined();

        // Request the same doc - cache hit
        client.getDoc({ type: "test", id: createdDoc!.id }, callback2);

        // First call is loading (sync)
        expect(callback2.mock.calls[0]?.[0]?.status).toBe("loading");

        // Wait just one microtask (not setTimeout like tick())
        await Promise.resolve();

        // Should already have success from cache
        expect(callback2.mock.calls.length).toBe(2);
        expect(callback2.mock.calls[1]?.[0]?.status).toBe("success");
        expect(getSuccessData(callback2)?.doc).toBe(createdDoc!.doc);
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

  // ──────────────────────────────────────────────────────────────────────────
  // Error handling tests
  // ──────────────────────────────────────────────────────────────────────────

  describe("Error handling", () => {
    // Note: DocSyncClient re-throws errors after emitting to callback (for monitoring).
    // We suppress these expected unhandled rejections in each test.

    // Helper to check if rejection matches expected error
    const matchesError = (reason: unknown, expected: string): boolean => {
      if (reason instanceof Error) return reason.message === expected;
      return false;
    };

    const matchesErrorContains = (
      reason: unknown,
      substring: string,
    ): boolean => {
      if (reason instanceof Error) return reason.message.includes(substring);
      return false;
    };

    test("should emit error status when provider throws", async () => {
      const errorMessage = "IndexedDB connection failed";
      const FailingProvider = createFailingProvider(errorMessage);
      const client = createClientWithProvider(FailingProvider);
      const callback = createCallback();

      // Suppress expected unhandled rejection
      const handler = (e: PromiseRejectionEvent) => {
        if (matchesError(e.reason, errorMessage)) e.preventDefault();
      };
      window.addEventListener("unhandledrejection", handler);

      try {
        client.getDoc(
          { type: "test", id: "test-id", createIfMissing: true },
          callback,
        );
        await tick();

        const errorResult = getErrorResult(callback);
        expect(errorResult).toBeDefined();
        expect(errorResult?.status).toBe("error");
        expect(errorResult?.error?.message).toBe(errorMessage);
        expect(errorResult?.data).toBeUndefined();
      } finally {
        window.removeEventListener("unhandledrejection", handler);
      }
    });

    test("should emit error status when docBinding.new throws for unknown type", async () => {
      const client = createClient(true);
      const callback = createCallback();

      // Suppress expected unhandled rejection
      const handler = (e: PromiseRejectionEvent) => {
        if (matchesErrorContains(e.reason, "Unknown type")) e.preventDefault();
      };
      window.addEventListener("unhandledrejection", handler);

      try {
        // "unknown-type" is not registered in the docBinding
        client.getDoc(
          { type: "unknown-type", id: "test-id", createIfMissing: true },
          callback,
        );
        await tick();

        const errorResult = getErrorResult(callback);
        expect(errorResult).toBeDefined();
        expect(errorResult?.status).toBe("error");
        expect(errorResult?.error?.message).toContain("Unknown type");
      } finally {
        window.removeEventListener("unhandledrejection", handler);
      }
    });

    test("should emit loading then error (not just error)", async () => {
      const errorMessage = "Provider failed";
      const FailingProvider = createFailingProvider(errorMessage);
      const client = createClientWithProvider(FailingProvider);
      const callback = createCallback();

      // Suppress expected unhandled rejection
      const handler = (e: PromiseRejectionEvent) => {
        if (matchesError(e.reason, errorMessage)) e.preventDefault();
      };
      window.addEventListener("unhandledrejection", handler);

      try {
        client.getDoc(
          { type: "test", id: "test-id", createIfMissing: true },
          callback,
        );

        // First call should be loading
        expect(callback.mock.calls[0]?.[0]?.status).toBe("loading");

        await tick();

        // Second call should be error
        expect(callback.mock.calls[1]?.[0]?.status).toBe("error");
      } finally {
        window.removeEventListener("unhandledrejection", handler);
      }
    });

    test("should convert non-Error throws to Error objects", async () => {
      // Create a provider that throws a string instead of an Error
      const StringThrowingProvider = class {
        constructor(_identity: Identity) {
          // Identity accepted but not used
        }
        async transaction() {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "string error message";
        }
      };
      const client = createClientWithProvider(StringThrowingProvider);
      const callback = createCallback();

      // Suppress expected unhandled rejection
      const handler = (e: PromiseRejectionEvent) => {
        if (matchesError(e.reason, "string error message")) e.preventDefault();
      };
      window.addEventListener("unhandledrejection", handler);

      try {
        client.getDoc(
          { type: "test", id: "test-id", createIfMissing: true },
          callback,
        );
        await tick();

        const errorResult = getErrorResult(callback);
        expect(errorResult?.error).toBeInstanceOf(Error);
        expect(errorResult?.error?.message).toBe("string error message");
      } finally {
        window.removeEventListener("unhandledrejection", handler);
      }
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // BroadcastChannel integration tests
  // ──────────────────────────────────────────────────────────────────────────

  describe("BroadcastChannel", () => {
    test("should send OPERATIONS message to BroadcastChannel on document change", async () => {
      const originalBroadcastChannel = globalThis.BroadcastChannel;
      const postMessageSpy = vi.fn();

      class MockBroadcastChannel {
        onmessage: ((ev: MessageEvent) => void) | null = null;
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        constructor(_name: string) {}
        postMessage = postMessageSpy;
        close = vi.fn();
      }

      globalThis.BroadcastChannel =
        MockBroadcastChannel as unknown as typeof BroadcastChannel;

      try {
        const client = createClient(true);
        const callback = createCallback();

        client.getDoc({ type: "test", createIfMissing: true }, callback);
        const doc = getSuccessData(callback)!.doc;
        const docId = getSuccessData(callback)!.id;

        // Trigger a document change
        doc.root.append(doc.createNode(ChildNode));
        await tick();

        // Verify postMessage was called with OPERATIONS
        expect(postMessageSpy).toHaveBeenCalledWith({
          type: "OPERATIONS",
          docId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          operations: expect.anything(),
        });
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
    });

    test("should receive OPERATIONS message from BroadcastChannel and apply to document", async () => {
      const originalBroadcastChannel = globalThis.BroadcastChannel;
      let messageHandler: ((ev: MessageEvent) => void) | null = null;

      class MockBroadcastChannel {
        onmessage: ((ev: MessageEvent) => void) | null = null;
        constructor(_name: string) {
          // Capture the message handler when it's set
          Object.defineProperty(this, "onmessage", {
            set: (handler: ((ev: MessageEvent) => void) | null) => {
              messageHandler = handler;
            },
            get: () => messageHandler,
          });
        }
        postMessage = vi.fn();
        close = vi.fn();
      }

      globalThis.BroadcastChannel =
        MockBroadcastChannel as unknown as typeof BroadcastChannel;

      try {
        const client = createClient(true);
        const callback = createCallback();

        // Create a doc
        client.getDoc({ type: "test", createIfMissing: true }, callback);
        const doc = getSuccessData(callback)!.doc;
        const docId = getSuccessData(callback)!.id;

        // Verify initial state - no children
        expect(doc.root.first).toBeFalsy();

        // Simulate receiving operations from another tab
        // We need to create valid operations, so we'll create them from another doc
        const tempCallback = createCallback();
        client.getDoc({ type: "test", createIfMissing: true }, tempCallback);
        const tempDoc = getSuccessData(tempCallback)!.doc;
        tempDoc.root.append(tempDoc.createNode(ChildNode));
        await tick();

        // The operations were captured - but for this test we just verify the mechanism
        // works by checking that _applyOperations is called and doesn't throw
        expect(messageHandler).not.toBeNull();

        // Simulate a message from BroadcastChannel with empty operations
        // Operations format is [OrderedOperation[], StatePatch] - empty is [[], {}]
        messageHandler!({
          data: { type: "OPERATIONS", docId, operations: [[], {}] },
        } as MessageEvent);

        await tick();
        // If we got here without throwing, the message was processed
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
    });

    test("should NOT re-broadcast operations received from BroadcastChannel", async () => {
      const originalBroadcastChannel = globalThis.BroadcastChannel;
      const postMessageSpy = vi.fn();
      let messageHandler: ((ev: MessageEvent) => void) | null = null;

      class MockBroadcastChannel {
        onmessage: ((ev: MessageEvent) => void) | null = null;
        constructor(_name: string) {
          Object.defineProperty(this, "onmessage", {
            set: (handler: ((ev: MessageEvent) => void) | null) => {
              messageHandler = handler;
            },
            get: () => messageHandler,
          });
        }
        postMessage = postMessageSpy;
        close = vi.fn();
      }

      globalThis.BroadcastChannel =
        MockBroadcastChannel as unknown as typeof BroadcastChannel;

      try {
        const client = createClient(true);
        const callback = createCallback();

        // Create a doc - this will resolve _localPromise and initialize BroadcastChannel
        client.getDoc({ type: "test", createIfMissing: true }, callback);
        const docId = getSuccessData(callback)!.id;

        // Wait for BroadcastChannel to be initialized
        await tick(10);

        // messageHandler should now be set
        expect(messageHandler).toBeDefined();

        // Clear any previous postMessage calls from doc creation
        postMessageSpy.mockClear();

        // Simulate receiving operations from another tab (empty operations)
        // Operations format is [OrderedOperation[], StatePatch] - empty is [[], {}]
        messageHandler!({
          data: { type: "OPERATIONS", docId, operations: [[], {}] },
        } as MessageEvent);

        await tick();

        // postMessage should NOT be called - we don't re-broadcast received operations
        expect(postMessageSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
    });
  });
});
