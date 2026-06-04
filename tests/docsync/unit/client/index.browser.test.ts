import { describe, test, expect, vi, expectTypeOf } from "vitest";
import {
  DocSyncClient,
  indexedDBProvider,
  type ClientConfig,
  type ClientProvider,
  type DocData,
  type DocBinding,
  type Identity,
  type QueryResult,
} from "@docukit/docsync/client";
import { DocNodeBinding } from "@docukit/docsync/docnode";
import {
  defineNode,
  type Doc,
  type JsonDoc,
  type Operations,
} from "@docukit/docnode";
import { ulid } from "ulid";
import {
  TestNode,
  ChildNode,
  createClient,
  createClientWithDisposeSpy,
  createClientWithProvider,
  createFailingProvider,
  createCallback,
  getSuccessData,
  getErrorResult,
} from "./utils.js";

// Mock socket.io-client to avoid real connections
vi.mock("socket.io-client", () => ({
  io: vi.fn(() => ({
    connected: true,
    on: vi.fn(),
    emit: vi.fn(
      (
        _event: string,
        _payload: unknown,
        callback?: (response: unknown) => void,
      ) => {
        if (!callback) return;
        if (
          _event === "sync" &&
          typeof _payload === "object" &&
          _payload !== null &&
          "docId" in _payload &&
          "clock" in _payload
        ) {
          callback({ data: { docId: _payload.docId, clock: _payload.clock } });
          return;
        }
        callback({ data: undefined, success: true });
      },
    ),
    disconnect: vi.fn(),
  })),
}));

// ============================================================================
// DocSyncClient Tests
// ============================================================================

describe("DocSyncClient", () => {
  type DebounceTestDoc = { docId: string };
  type DebounceTestSerializedDoc = { docId: string };
  type DebounceTestOperation = { value: string };
  type SaveOperations = (arg: {
    docId: string;
    operations: DebounceTestOperation[];
  }) => Promise<void>;

  const createDebounceTestClient = ({
    saveOperations,
    timing,
  }: {
    saveOperations: SaveOperations;
    timing?: { collabMaxDebounce?: number; singleClientMaxDebounce?: number };
  }) => {
    const docBinding: DocBinding<
      DebounceTestDoc,
      DebounceTestSerializedDoc,
      DebounceTestOperation
    > = {
      create: (_type, id) => {
        const docId = id ?? ulid().toLowerCase();
        return { doc: { docId }, docId };
      },
      deserialize: (serializedDoc) => ({ docId: serializedDoc.docId }),
      serialize: (doc) => ({ docId: doc.docId }),
      onChange: () => undefined,
      applyOperations: () => undefined,
      dispose: () => undefined,
    };

    const provider: ClientProvider<
      DebounceTestSerializedDoc,
      DebounceTestOperation
    > = {
      transaction: (_mode, callback) =>
        callback({
          getSerializedDoc: ({ docId }) =>
            Promise.resolve({ serializedDoc: { docId }, clock: 0 }),
          getOperations: () => Promise.resolve([]),
          deleteOperations: () => Promise.resolve(undefined),
          saveOperations,
          saveSerializedDoc: () => Promise.resolve(undefined),
        }),
    };

    const config: ClientConfig<
      DebounceTestDoc,
      DebounceTestSerializedDoc,
      DebounceTestOperation
    > = {
      server: {
        url: "ws://localhost:8081",
        auth: { getToken: () => "test-token" },
      },
      docBinding,
      local: {
        provider: () => provider,
        getIdentity: () => ({
          userId: `debounce-test-${ulid().toLowerCase()}`,
          secret: "test-secret",
        }),
      },
    };

    if (timing !== undefined) {
      config.timing = timing;
    }

    return new DocSyncClient(config);
  };

  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  type DebounceTestClient = DocSyncClient<
    DebounceTestDoc,
    DebounceTestSerializedDoc,
    DebounceTestOperation
  >;

  const getSocketOnMock = (client: DebounceTestClient) => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- socket is a Vitest mock in this test file.
    const onMock = vi.mocked(client["_socket"].on);
    return onMock;
  };

  const getSocketEmitMock = (client: DebounceTestClient) => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- socket is a Vitest mock in this test file.
    const emitMock = vi.mocked(client["_socket"].emit);
    return emitMock;
  };

  const emitMockedConnect = (client: DebounceTestClient) => {
    const onMock = getSocketOnMock(client);
    const eventCall = onMock.mock.calls.find(([event]) => event === "connect");
    if (!eventCall) {
      throw new Error("Expected socket listener for connect");
    }

    const listener = eventCall[1];
    Reflect.apply(listener, undefined, []);
  };

  const emitMockedCollaboration = (
    client: DebounceTestClient,
    payload: { docId: string; hasCollaborators: boolean },
  ) => {
    const onMock = getSocketOnMock(client);
    const eventCall = onMock.mock.calls.find(
      ([event]) => event === "collaboration",
    );
    if (!eventCall) {
      throw new Error("Expected socket listener for collaboration");
    }

    const listener = eventCall[1];
    Reflect.apply(listener, undefined, [payload]);
  };

  const cacheDebounceTestDoc = (client: DebounceTestClient, docId: string) => {
    client["_docsCache"].set(docId, {
      promisedDoc: Promise.resolve({ docId }),
      refCount: 1,
      type: "test",
      presence: {},
      presenceListeners: new Set(),
    });
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Constructor tests
  // ──────────────────────────────────────────────────────────────────────────

  describe("constructor", () => {
    test("should throw error when duplicate type is provided", () => {
      const DuplicateNode = defineNode({ type: "test" });

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
      const client = createClient();
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
        const client = createClient();
        const callback = createCallback();

        // Trigger _localPromise resolution by calling getDoc
        client.getDoc({ type: "test", createIfMissing: true }, callback);

        await expect.poll(() => constructorSpy.mock.calls.length).toBe(1);
        // BroadcastChannel name should be user-specific: "docsync:{userId}"
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const channelName = constructorSpy.mock.calls[0]?.[0];
        expect(channelName).toMatch(/^docsync:test-user-/);
        expect(client).toBeInstanceOf(DocSyncClient);
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
    });

    test("should not post to BroadcastChannel after helper is closed", async () => {
      const originalBroadcastChannel = globalThis.BroadcastChannel;
      const postMessageSpy = vi.fn();
      const closeSpy = vi.fn();

      class MockBroadcastChannel {
        onmessage: ((ev: MessageEvent) => void) | null = null;
        constructor(_name: string) {
          // no-op
        }
        postMessage(message: unknown) {
          postMessageSpy(message);
        }
        close() {
          closeSpy();
        }
      }

      globalThis.BroadcastChannel =
        MockBroadcastChannel as unknown as typeof BroadcastChannel;

      try {
        const client = createClient();
        const callback = createCallback();

        client.getDoc({ type: "test", createIfMissing: true }, callback);
        await expect.poll(() => client["_bcHelper"]).toBeDefined();

        const bcHelper = client["_bcHelper"];
        if (!bcHelper) {
          throw new Error("Expected BroadcastChannel helper to be initialized");
        }

        bcHelper.close();
        bcHelper.broadcast({
          type: "PRESENCE",
          docId: "doc-id",
          presence: { test: true },
        });

        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(postMessageSpy).not.toHaveBeenCalled();
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
    });
  });

  describe("presence debounce", () => {
    test("uses collaborative timing for cross-tab presence without server presence", async () => {
      vi.useFakeTimers();

      try {
        const saveOperations = vi.fn<SaveOperations>(() =>
          Promise.resolve(undefined),
        );
        const client = createDebounceTestClient({
          saveOperations,
          timing: { collabMaxDebounce: 50, singleClientMaxDebounce: 3000 },
        });
        await client["_localPromise"];

        const docId = "doc-1";
        cacheDebounceTestDoc(client, docId);

        const bcHelper = client["_bcHelper"];
        if (!bcHelper) {
          throw new Error("Expected BroadcastChannel helper to be initialized");
        }
        const broadcastSpy = vi.spyOn(bcHelper, "broadcast");

        client.setPresence({ docId, presence: { anchor: 1 } });

        expect(
          client["_presenceDebounceState"].get(docId)?.timeout,
        ).toBeDefined();

        await vi.advanceTimersByTimeAsync(49);
        expect(broadcastSpy).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(broadcastSpy).toHaveBeenCalledWith({
          type: "PRESENCE",
          docId,
          presence: { [client["_clientId"]]: { anchor: 1 } },
        });
        expect(client["_presenceDebounceState"].get(docId)?.timeout).toBe(
          undefined,
        );
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    test("uses one collaborative debounce for presence", async () => {
      vi.useFakeTimers();

      try {
        const saveOperations = vi.fn<SaveOperations>(() =>
          Promise.resolve(undefined),
        );
        const client = createDebounceTestClient({
          saveOperations,
          timing: { collabMaxDebounce: 50 },
        });
        await client["_localPromise"];

        const docId = "doc-1";
        cacheDebounceTestDoc(client, docId);

        client.setPresence({ docId, presence: { anchor: 1 } });
        const firstTimeout =
          client["_presenceDebounceState"].get(docId)?.timeout;
        expect(firstTimeout).toBeDefined();

        client["_collabDocIds"].add(docId);
        client.setPresence({ docId, presence: { anchor: 2 } });
        expect(client["_presenceDebounceState"].get(docId)?.timeout).toBe(
          firstTimeout,
        );

        await vi.advanceTimersByTimeAsync(50);
        expect(client["_presenceDebounceState"].get(docId)?.timeout).toBe(
          undefined,
        );
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    test("sends current presence to server when collaborators appear after local flush", async () => {
      vi.useFakeTimers();

      try {
        const saveOperations = vi.fn<SaveOperations>(() =>
          Promise.resolve(undefined),
        );
        const client = createDebounceTestClient({
          saveOperations,
          timing: { collabMaxDebounce: 50 },
        });
        await client["_localPromise"];

        const docId = "doc-1";
        cacheDebounceTestDoc(client, docId);

        client.setPresence({ docId, presence: { anchor: 1 } });
        await vi.advanceTimersByTimeAsync(50);

        const emitMock = getSocketEmitMock(client);
        expect(emitMock).not.toHaveBeenCalledWith(
          "presence",
          { docId, presence: { anchor: 1 } },
          expect.any(Function),
        );

        emitMockedCollaboration(client, { docId, hasCollaborators: true });

        expect(emitMock).toHaveBeenCalledWith(
          "presence",
          { docId, presence: { anchor: 1 } },
          expect.any(Function),
        );
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    test("waits for pending presence debounce before sending server presence to new collaborators", async () => {
      vi.useFakeTimers();

      try {
        const saveOperations = vi.fn<SaveOperations>(() =>
          Promise.resolve(undefined),
        );
        const client = createDebounceTestClient({
          saveOperations,
          timing: { collabMaxDebounce: 50 },
        });
        await client["_localPromise"];

        const docId = "doc-1";
        cacheDebounceTestDoc(client, docId);

        client.setPresence({ docId, presence: { anchor: 1 } });
        emitMockedCollaboration(client, { docId, hasCollaborators: true });

        const emitMock = getSocketEmitMock(client);
        expect(emitMock).not.toHaveBeenCalledWith(
          "presence",
          { docId, presence: { anchor: 1 } },
          expect.any(Function),
        );

        await vi.advanceTimersByTimeAsync(50);

        expect(emitMock).toHaveBeenCalledWith(
          "presence",
          { docId, presence: { anchor: 1 } },
          expect.any(Function),
        );
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    test("remote changes flush only presence recalculated by that change", async () => {
      type FakeDoc = { id: string };
      type FakeSerializedDoc = { id: string };
      type FakeOperation = { value: string };
      type FakeChangeListener = (ev: { operations: FakeOperation }) => void;

      const changeListeners = new Set<FakeChangeListener>();
      const docBinding: DocBinding<FakeDoc, FakeSerializedDoc, FakeOperation> =
        {
          create: (_type, id) => {
            const docId = id ?? ulid().toLowerCase();
            return { doc: { id: docId }, docId };
          },
          deserialize: (serializedDoc) => ({ id: serializedDoc.id }),
          serialize: (doc) => ({ id: doc.id }),
          onChange: (_doc, cb) => {
            changeListeners.add(cb);
          },
          applyOperations: (_doc, operations) => {
            changeListeners.forEach((listener) => listener({ operations }));
          },
          dispose: vi.fn(),
        };
      const config: ClientConfig<FakeDoc, FakeSerializedDoc, FakeOperation> = {
        server: {
          url: "ws://localhost:8081",
          auth: { getToken: () => "test-token" },
        },
        docBinding,
        local: {
          provider: indexedDBProvider,
          getIdentity: () => ({
            userId: `presence-flush-${ulid().toLowerCase()}`,
            secret: "test-secret",
          }),
        },
      };
      const client = new DocSyncClient(config);
      await client["_localPromise"];

      const docId = ulid().toLowerCase();
      let latestResult: QueryResult<DocData<FakeDoc>> | undefined;
      client.getDoc(
        { type: "test", id: docId, createIfMissing: true },
        (result) => {
          latestResult = result;
        },
      );
      await expect.poll(() => latestResult?.status).toBe("success");
      await expect.poll(() => changeListeners.size).toBe(1);
      if (latestResult?.status !== "success") {
        throw new Error("Expected fake document to load successfully");
      }
      const doc = latestResult.data.doc;

      const bcHelper = client["_bcHelper"];
      if (!bcHelper) {
        throw new Error("Expected BroadcastChannel helper to be initialized");
      }
      const broadcastSpy = vi.spyOn(bcHelper, "broadcast");

      client.setPresence({ docId, presence: { anchor: 1 } });
      const firstTimeout = client["_presenceDebounceState"].get(docId)?.timeout;
      expect(firstTimeout).toBeDefined();

      client["_applyOperationsFrom"]("network", doc, {
        value: "unrelated-remote-change",
      });
      await Promise.resolve();

      expect(client["_presenceDebounceState"].get(docId)?.timeout).toBe(
        firstTimeout,
      );
      expect(broadcastSpy).not.toHaveBeenCalled();

      changeListeners.add(() => {
        client.setPresence({ docId, presence: { anchor: 2 } });
      });

      client["_applyOperationsFrom"]("network", doc, {
        value: "selection-changing-remote-change",
      });
      await Promise.resolve();

      expect(client["_presenceDebounceState"].get(docId)?.timeout).toBe(
        undefined,
      );
      expect(client["_presenceDebounceState"].get(docId)?.data).toStrictEqual({
        anchor: 2,
      });
      expect(broadcastSpy).toHaveBeenCalledWith({
        type: "PRESENCE",
        docId,
        presence: { [client["_clientId"]]: { anchor: 2 } },
      });
    });
  });

  describe("local operations debounce", () => {
    test("batches collaborative local operation persistence until max debounce", async () => {
      vi.useFakeTimers();

      try {
        const saveOperations = vi.fn<SaveOperations>(() =>
          Promise.resolve(undefined),
        );
        const client = createDebounceTestClient({
          saveOperations,
          timing: { collabMaxDebounce: 1000 },
        });
        await client["_localPromise"];
        client["_collabDocIds"].add("doc-1");

        client.onLocalOperations({
          docId: "doc-1",
          operations: [{ value: "A" }],
        });
        await vi.advanceTimersByTimeAsync(999);
        expect(saveOperations).not.toHaveBeenCalled();

        client.onLocalOperations({
          docId: "doc-1",
          operations: [{ value: "B" }],
        });
        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();

        expect(saveOperations).toHaveBeenCalledOnce();
        expect(saveOperations).toHaveBeenCalledWith({
          docId: "doc-1",
          operations: [{ value: "A" }, { value: "B" }],
        });
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    test("uses single-client debounce when document has no collaborators", async () => {
      vi.useFakeTimers();

      try {
        const saveOperations = vi.fn<SaveOperations>(() =>
          Promise.resolve(undefined),
        );
        const client = createDebounceTestClient({
          saveOperations,
          timing: { collabMaxDebounce: 50, singleClientMaxDebounce: 100 },
        });
        await client["_localPromise"];

        client.onLocalOperations({
          docId: "doc-1",
          operations: [{ value: "A" }],
        });
        await vi.advanceTimersByTimeAsync(40);

        client.onLocalOperations({
          docId: "doc-1",
          operations: [{ value: "B" }],
        });
        await vi.advanceTimersByTimeAsync(40);

        client.onLocalOperations({
          docId: "doc-1",
          operations: [{ value: "C" }],
        });
        await vi.advanceTimersByTimeAsync(19);
        await flushMicrotasks();
        expect(saveOperations).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();

        expect(saveOperations).toHaveBeenCalledOnce();
        expect(saveOperations).toHaveBeenCalledWith({
          docId: "doc-1",
          operations: [{ value: "A" }, { value: "B" }, { value: "C" }],
        });
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    test("flushes pending single-client operations when a collaborator appears", async () => {
      vi.useFakeTimers();

      try {
        const saveOperations = vi.fn<SaveOperations>(() =>
          Promise.resolve(undefined),
        );
        const client = createDebounceTestClient({
          saveOperations,
          timing: { collabMaxDebounce: 50, singleClientMaxDebounce: 3000 },
        });
        await client["_localPromise"];

        const docId = "doc-1";
        cacheDebounceTestDoc(client, docId);
        client.onLocalOperations({ docId, operations: [{ value: "A" }] });

        await vi.advanceTimersByTimeAsync(2999);
        expect(saveOperations).not.toHaveBeenCalled();

        emitMockedCollaboration(client, { docId, hasCollaborators: true });
        await flushMicrotasks();

        expect(saveOperations).toHaveBeenCalledWith({
          docId,
          operations: [{ value: "A" }],
        });

        const emitMock = getSocketEmitMock(client);
        await expect
          .poll(() => emitMock.mock.calls.some(([event]) => event === "sync"))
          .toBe(true);
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("connect", () => {
    test("flushes pending local operations before syncing on reconnect", async () => {
      const saveOperations = vi.fn<SaveOperations>(() =>
        Promise.resolve(undefined),
      );
      const client = createDebounceTestClient({
        saveOperations,
        timing: { singleClientMaxDebounce: 1000 },
      });
      await client["_localPromise"];

      const docId = "doc-1";
      cacheDebounceTestDoc(client, docId);
      client.onLocalOperations({ docId, operations: [{ value: "A" }] });

      emitMockedConnect(client);

      await expect
        .poll(() => saveOperations)
        .toHaveBeenCalledWith({ docId, operations: [{ value: "A" }] });

      const emitMock = getSocketEmitMock(client);
      await expect
        .poll(() => emitMock.mock.calls.some(([event]) => event === "sync"))
        .toBe(true);

      const syncCallOrder = emitMock.mock.invocationCallOrder.find(
        (_order, index) => emitMock.mock.calls[index]?.[0] === "sync",
      );
      if (syncCallOrder === undefined) {
        throw new Error("Expected sync emit call");
      }
      expect(saveOperations.mock.invocationCallOrder[0]).toBeLessThan(
        syncCallOrder,
      );
      client.disconnect();
    });

    test("syncs a loaded document on reconnect even if its pending batch is empty", async () => {
      const saveOperations = vi.fn<SaveOperations>(() =>
        Promise.resolve(undefined),
      );
      const client = createDebounceTestClient({
        saveOperations,
        timing: { singleClientMaxDebounce: 1000 },
      });
      await client["_localPromise"];

      const docId = "doc-1";
      cacheDebounceTestDoc(client, docId);
      client.onLocalOperations({ docId, operations: [] });

      emitMockedConnect(client);

      await flushMicrotasks();
      expect(saveOperations).not.toHaveBeenCalled();

      const emitMock = getSocketEmitMock(client);
      await expect
        .poll(() => emitMock.mock.calls.some(([event]) => event === "sync"))
        .toBe(true);
      client.disconnect();
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
      const client = createClient();
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
        | { status: "pending"; data?: never; error?: never }
        | { status: "success"; data: DocData<Doc>; error?: never }
        | { status: "error"; data?: never; error: Error }
      >();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // getDoc tests
  // ──────────────────────────────────────────────────────────────────────────

  describe("getDoc", () => {
    describe("Get existing document", () => {
      test("should emit pending status initially", () => {
        const client = createClient();
        const callback = createCallback();

        client.getDoc({ type: "test", id: "test-id" }, callback);

        expect(callback).toHaveBeenCalledWith({
          status: "pending",
          data: undefined,
          error: undefined,
        });
      });

      test("should return undefined when document does not exist and createIfMissing is false", async () => {
        const client = createClient();
        const callback = createCallback();

        client.getDoc({ type: "test", id: "non-existent-id" }, callback);
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0])
          .toEqual({ status: "success", data: undefined, error: undefined });
      });

      test("should return cached document when requested multiple times", async () => {
        const client = createClient();
        const callback1 = createCallback();
        const callback2 = createCallback();

        // Create a doc first
        client.getDoc({ type: "test", createIfMissing: true }, callback1);
        await expect.poll(() => getSuccessData(callback1)).toBeDefined();
        const createdDoc = getSuccessData(callback1);

        // Request the same doc again
        client.getDoc({ type: "test", id: createdDoc!.docId }, callback2);
        await expect.poll(() => getSuccessData(callback2)).toBeDefined();
        const cachedDoc = getSuccessData(callback2);
        expect(cachedDoc?.doc).toBe(createdDoc!.doc);
      });

      test("should resolve cache hit on next microtask (no setTimeout needed)", async () => {
        const client = createClient();
        const callback1 = createCallback();
        const callback2 = createCallback();

        // Create a doc first (sync path)
        client.getDoc({ type: "test", createIfMissing: true }, callback1);
        const createdDoc = getSuccessData(callback1);
        expect(createdDoc).toBeDefined();

        // Request the same doc - cache hit
        client.getDoc({ type: "test", id: createdDoc!.docId }, callback2);

        // First call is pending (sync)
        expect(callback2.mock.calls[0]?.[0]?.status).toBe("pending");

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
        const client = createClient();
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
              docId: expect.any(String),
            }),
          }),
        );
      });

      test("should generate unique IDs for each new document", () => {
        const client = createClient();
        const callback1 = createCallback();
        const callback2 = createCallback();

        client.getDoc({ type: "test", createIfMissing: true }, callback1);
        client.getDoc({ type: "test", createIfMissing: true }, callback2);

        const id1 = callback1.mock.calls[0]?.[0]?.data?.docId;
        const id2 = callback2.mock.calls[0]?.[0]?.data?.docId;

        expect(id1).toBeDefined();
        expect(id2).toBeDefined();
        expect(id1).not.toBe(id2);
      });

      test("should return unsubscribe function", () => {
        const client = createClient();
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
        const client = createClient();
        const callback = createCallback();
        const customId = ulid().toLowerCase();

        client.getDoc(
          { type: "test", id: customId, createIfMissing: true },
          callback,
        );
        await expect.poll(() => getSuccessData(callback)?.docId).toBe(customId);
      });
    });

    describe("Sync vs async behavior", () => {
      test("should NOT emit pending when creating new doc without id", () => {
        const client = createClient();
        const callback = createCallback();

        client.getDoc({ type: "test", createIfMissing: true }, callback);

        // First call should be success, not pending
        expect(callback.mock.calls[0]?.[0]?.status).toBe("success");
        expect(callback).toHaveBeenCalledTimes(1);
      });

      test("should emit pending before success when fetching by id", async () => {
        const client = createClient();
        const callback = createCallback();
        const customId = ulid().toLowerCase();

        client.getDoc({ type: "test", id: customId }, callback);

        // First call should be pending
        expect(callback.mock.calls[0]?.[0]?.status).toBe("pending");

        await expect
          .poll(() => callback.mock.calls[1]?.[0]?.status)
          .toBe("success");
      });
    });

    describe("Unsubscribe", () => {
      test("should remove doc from cache and call dispose when last subscriber unsubscribes", async () => {
        const { client, disposeSpy } = createClientWithDisposeSpy();
        const callback = createCallback();

        const unsubscribe = client.getDoc(
          { type: "test", createIfMissing: true },
          callback,
        );
        const doc = getSuccessData(callback)!.doc;
        const docId = getSuccessData(callback)!.docId;
        const cache = client["_docsCache"];

        expect(cache.has(docId)).toBe(true);
        expect(cache.get(docId)?.refCount).toBe(1);
        expect(disposeSpy).not.toHaveBeenCalled();

        unsubscribe();
        await expect.poll(() => !cache.has(docId)).toBe(true);
        expect(disposeSpy).toHaveBeenCalledOnce();
        expect(disposeSpy).toHaveBeenCalledWith(doc);
      });

      test("should NOT call dispose when non-last subscriber unsubscribes", async () => {
        const { client, disposeSpy } = createClientWithDisposeSpy();
        const callback1 = createCallback();
        const callback2 = createCallback();

        // First subscription creates the doc
        const unsubscribe1 = client.getDoc(
          { type: "test", createIfMissing: true },
          callback1,
        );
        const doc = getSuccessData(callback1)!.doc;
        const docId = getSuccessData(callback1)!.docId;

        // Second subscription to same doc
        const unsubscribe2 = client.getDoc(
          { type: "test", id: docId },
          callback2,
        );
        const cache = client["_docsCache"];
        await expect.poll(() => cache.get(docId)?.refCount).toBe(2);

        // Unsubscribe first one - should NOT call dispose
        unsubscribe1();
        await expect.poll(() => cache.get(docId)?.refCount).toBe(1);
        expect(cache.has(docId)).toBe(true);
        expect(disposeSpy).not.toHaveBeenCalled();

        // Unsubscribe second one - should call dispose
        unsubscribe2();
        await expect.poll(() => !cache.has(docId)).toBe(true);
        expect(disposeSpy).toHaveBeenCalledOnce();
        expect(disposeSpy).toHaveBeenCalledWith(doc);
      });
    });

    describe("refCount / multiple subscriptions", () => {
      test("should increment refCount for each subscription to same doc", async () => {
        const client = createClient();
        const callback1 = createCallback();
        const callback2 = createCallback();
        const callback3 = createCallback();

        // Create doc
        client.getDoc({ type: "test", createIfMissing: true }, callback1);
        const docId = getSuccessData(callback1)!.docId;

        const cache = client["_docsCache"];
        expect(cache.get(docId)?.refCount).toBe(1);

        // Second subscription
        client.getDoc({ type: "test", id: docId }, callback2);
        await expect.poll(() => cache.get(docId)?.refCount).toBe(2);

        // Third subscription
        client.getDoc({ type: "test", id: docId }, callback3);
        await expect.poll(() => cache.get(docId)?.refCount).toBe(3);
      });

      test("should share same doc instance across multiple subscriptions", async () => {
        const client = createClient();
        const callback1 = createCallback();
        const callback2 = createCallback();

        // Create doc
        client.getDoc({ type: "test", createIfMissing: true }, callback1);
        const doc1 = getSuccessData(callback1)!.doc;

        // Second subscription
        client.getDoc(
          { type: "test", id: getSuccessData(callback1)!.docId },
          callback2,
        );
        await expect.poll(() => getSuccessData(callback2)?.doc).toBeDefined();
        const doc2 = getSuccessData(callback2)?.doc;

        // Same instance
        expect(doc1).toBe(doc2);
      });

      test("should NOT notify callback when document content changes", async () => {
        const client = createClient();
        const callback = createCallback();

        // Create doc
        client.getDoc({ type: "test", createIfMissing: true }, callback);
        const doc = getSuccessData(callback)!.doc;

        // Initial call count (1 for success)
        expect(callback.mock.calls.length).toBe(1);

        // Trigger a document change
        doc.root.append(doc.createNode(ChildNode));
        // Callback should NOT be called on doc changes (poll until stable)
        await expect.poll(() => callback.mock.calls.length).toBe(1);
      });
    });

    describe("Concurrency", () => {
      test("should share promise when multiple requests for same doc happen simultaneously", async () => {
        const client = createClient();
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

        await expect.poll(() => getSuccessData(callback1)?.doc).toBeDefined();
        const doc1 = getSuccessData(callback1)?.doc;
        const doc2 = getSuccessData(callback2)?.doc;
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
        await expect.poll(() => getErrorResult(callback)).toBeDefined();
        const errorResult = getErrorResult(callback);
        expect(errorResult?.status).toBe("error");
        expect(errorResult?.error?.message).toBe(errorMessage);
        expect(errorResult?.data).toBeUndefined();
      } finally {
        window.removeEventListener("unhandledrejection", handler);
      }
    });

    test("should emit error status when docBinding.new throws for unknown type", async () => {
      const client = createClient();
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
        await expect.poll(() => getErrorResult(callback)).toBeDefined();
        const errorResult = getErrorResult(callback);
        expect(errorResult?.status).toBe("error");
        expect(errorResult?.error?.message).toContain("Unknown type");
      } finally {
        window.removeEventListener("unhandledrejection", handler);
      }
    });

    test("should emit pending then error (not just error)", async () => {
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

        // First call should be pending
        expect(callback.mock.calls[0]?.[0]?.status).toBe("pending");

        await expect
          .poll(() => callback.mock.calls[1]?.[0]?.status)
          .toBe("error");
      } finally {
        window.removeEventListener("unhandledrejection", handler);
      }
    });

    test("should convert non-Error throws to Error objects", async () => {
      // Create a provider that throws a string instead of an Error
      const StringThrowingProvider = (_identity: Identity) => ({
        // eslint-disable-next-line @typescript-eslint/require-await -- sync implementation of async interface
        async transaction() {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "string error message";
        },
      });
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
        await expect.poll(() => getErrorResult(callback)).toBeDefined();
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
        const client = createClient();
        const callback = createCallback();

        client.getDoc({ type: "test", createIfMissing: true }, callback);
        const doc = getSuccessData(callback)!.doc;
        const docId = getSuccessData(callback)!.docId;

        // Trigger a document change
        doc.root.append(doc.createNode(ChildNode));
        await expect
          .poll(() => postMessageSpy.mock.calls.length)
          .toBeGreaterThan(0);
        expect(postMessageSpy).toHaveBeenCalledWith({
          type: "OPERATIONS",
          docId,
          source: "local-broadcast",
          flags: { skipUndo: true },
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
        const client = createClient();
        const callback = createCallback();

        // Create a doc
        client.getDoc({ type: "test", createIfMissing: true }, callback);
        const doc = getSuccessData(callback)!.doc;
        const docId = getSuccessData(callback)!.docId;

        // Verify initial state - no children
        expect(doc.root.first).toBeFalsy();

        // Simulate receiving operations from another tab
        // We need to create valid operations, so we'll create them from another doc
        const tempCallback = createCallback();
        client.getDoc({ type: "test", createIfMissing: true }, tempCallback);
        const tempDoc = getSuccessData(tempCallback)!.doc;
        tempDoc.root.append(tempDoc.createNode(ChildNode));
        await expect.poll(() => messageHandler !== null).toBe(true);

        // Simulate a message from BroadcastChannel with empty operations
        // Operations format is [OrderedOperation[], StatePatch] - empty is [[], {}]
        messageHandler!({
          data: { type: "OPERATIONS", docId, operations: [[], {}] },
        } as MessageEvent);
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
        const client = createClient();
        const callback = createCallback();

        // Create a doc - this will resolve _localPromise and initialize BroadcastChannel
        client.getDoc({ type: "test", createIfMissing: true }, callback);
        const docId = getSuccessData(callback)!.docId;

        await expect.poll(() => messageHandler !== undefined).toBe(true);

        // Clear any previous postMessage calls from doc creation
        postMessageSpy.mockClear();

        // Simulate receiving operations from another tab (empty operations)
        // Operations format is [OrderedOperation[], StatePatch] - empty is [[], {}]
        messageHandler!({
          data: { type: "OPERATIONS", docId, operations: [[], {}] },
        } as MessageEvent);

        // postMessage should NOT be called - we don't re-broadcast received operations
        await expect.poll(() => postMessageSpy.mock.calls.length).toBe(0);
      } finally {
        globalThis.BroadcastChannel = originalBroadcastChannel;
      }
    });
  });

  describe("types", () => {
    test("DocSyncClient<D,S,O> is assignable to DocSyncClient (base type)", () => {
      const client = createClient();
      expectTypeOf(client).toEqualTypeOf<
        DocSyncClient<Doc, JsonDoc, Operations>
      >();
      expectTypeOf<
        DocSyncClient<Doc, JsonDoc, Operations>
      >().toExtend<DocSyncClient>();
    });
  });
});
