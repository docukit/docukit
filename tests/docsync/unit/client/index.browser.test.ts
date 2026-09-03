import { beforeEach, describe, test, expect, vi, expectTypeOf } from "vitest";
import {
  DocSyncClient,
  DocSyncError,
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
  cacheLocalIdentity,
  clearCachedLocalIdentity,
  LOCAL_IDENTITY_KEY,
  subscribeToDoc,
} from "./utils.js";

type SocketAuthPayload = {
  deviceId: string;
  clientId: string;
  token?: string;
  claimedUserId?: string;
};

type MockIdentityPayload = { userId: string };

const socketMockState = vi.hoisted(() => ({
  autoIdentity: true,
  identityPayload: undefined as MockIdentityPayload | undefined,
  syncResponses: new Map<string, unknown>(),
  syncErrors: new Map<string, Error>(),
  /**
   * Documents whose sync ack is withheld, so a test can settle the query
   * through a later sync and then release the superseded one.
   */
  deferSyncDocIds: new Set<string>(),
  deferredSyncAcks: new Map<string, ((response: unknown) => void)[]>(),
}));

// Mock socket.io-client to avoid real connections
const ioMock = vi.hoisted(() =>
  vi.fn(
    (
      _url: string,
      _options?: {
        auth?: (callback: (payload: SocketAuthPayload) => void) => void;
        withCredentials?: boolean;
      },
    ) => {
      return {
        connected: true,
        active: true,
        on: vi.fn((event: string, listener: (payload?: unknown) => void) => {
          if (event === "identity" && socketMockState.autoIdentity) {
            queueMicrotask(() =>
              listener(
                socketMockState.identityPayload ?? { userId: "mock-user" },
              ),
            );
          }
        }),
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
              const docId = _payload.docId;
              const clock = _payload.clock;
              if (typeof docId !== "string" || typeof clock !== "number") {
                callback({ data: undefined, success: true });
                return;
              }

              const syncError = socketMockState.syncErrors.get(docId);
              if (syncError) throw syncError;

              if (socketMockState.deferSyncDocIds.has(docId)) {
                const acks = socketMockState.deferredSyncAcks.get(docId) ?? [];
                acks.push(callback);
                socketMockState.deferredSyncAcks.set(docId, acks);
                return;
              }

              const mockedResponse = socketMockState.syncResponses.get(docId);
              if (mockedResponse !== undefined) {
                callback(mockedResponse);
                return;
              }

              callback({
                data: { docId, operations: [], serializedDoc: null, clock },
              });
              return;
            }
            callback({ data: undefined, success: true });
          },
        ),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
    },
  ),
);

vi.mock("socket.io-client", () => ({ io: ioMock }));

// ============================================================================
// DocSyncClient Tests
// ============================================================================

describe("DocSyncClient", () => {
  beforeEach(() => {
    ioMock.mockClear();
    socketMockState.autoIdentity = true;
    socketMockState.identityPayload = undefined;
    socketMockState.syncResponses.clear();
    socketMockState.syncErrors.clear();
    socketMockState.deferSyncDocIds.clear();
    socketMockState.deferredSyncAcks.clear();
    clearCachedLocalIdentity();
  });

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

    cacheLocalIdentity("mock-user");

    const config: ClientConfig<
      DebounceTestDoc,
      DebounceTestSerializedDoc,
      DebounceTestOperation
    > = {
      server: {
        url: "ws://localhost:8081",
        auth: { mode: "token", getToken: () => "test-token" },
      },
      docBinding,
      local: { provider: () => provider },
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

  test("request auth sends handshake metadata without reading a token", () => {
    ioMock.mockClear();

    const client = new DocSyncClient({
      server: { url: "ws://localhost:8081", auth: { mode: "request" } },
      docBinding: DocNodeBinding([]),
      local: { provider: indexedDBProvider },
    });

    const options = ioMock.mock.calls.at(-1)?.[1];
    if (!options || typeof options.auth !== "function") {
      throw new Error("Expected socket auth callback");
    }

    let authPayload: SocketAuthPayload | undefined;
    options.auth((payload) => {
      authPayload = payload;
    });

    expect(options.withCredentials).toBe(true);
    expect(authPayload).toBeDefined();
    if (!authPayload) {
      throw new Error("Expected socket auth payload");
    }
    expect(typeof authPayload.deviceId).toBe("string");
    expect(authPayload).toMatchObject({ clientId: client["_clientId"] });
    expect(authPayload).not.toHaveProperty("token");
    expect(authPayload.claimedUserId).toBe(null);
  });

  type DebounceTestClient = DocSyncClient<
    DebounceTestDoc,
    DebounceTestSerializedDoc,
    DebounceTestOperation
  >;

  const getSocketOnMock = <
    D extends object,
    S extends object,
    O extends object,
  >(
    client: DocSyncClient<D, S, O>,
  ) => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- socket is a Vitest mock in this test file.
    const onMock = vi.mocked(client["_socket"].on);
    return onMock;
  };

  const getSocketEmitMock = <
    D extends object,
    S extends object,
    O extends object,
  >(
    client: DocSyncClient<D, S, O>,
  ) => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- socket is a Vitest mock in this test file.
    const emitMock = vi.mocked(client["_socket"].emit);
    return emitMock;
  };

  const getSocketConnectMock = <
    D extends object,
    S extends object,
    O extends object,
  >(
    client: DocSyncClient<D, S, O>,
  ) => {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- socket is a Vitest mock in this test file.
    const connectMock = vi.mocked(client["_socket"].connect);
    return connectMock;
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

  /** Drives the socket flags the query state machine reads. */
  const setSocketState = <D extends object, S extends object, O extends object>(
    client: DocSyncClient<D, S, O>,
    state: { active: boolean; connected: boolean },
  ) => {
    Object.defineProperties(client["_socket"], {
      active: { configurable: true, value: state.active },
      connected: { configurable: true, value: state.connected },
    });
  };

  const emitMockedSocketEvent = <
    D extends object,
    S extends object,
    O extends object,
  >(
    client: DocSyncClient<D, S, O>,
    event: "connect" | "connect_error" | "disconnect",
    payload?: unknown,
  ) => {
    const onMock = getSocketOnMock(client);
    const eventCall = onMock.mock.calls.find(
      ([registeredEvent]) => registeredEvent === event,
    );
    if (!eventCall) {
      throw new Error(`Expected socket listener for ${event}`);
    }

    const listener = eventCall[1];
    Reflect.apply(listener, undefined, payload === undefined ? [] : [payload]);
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

  const createIndexedDBProviderSpy = () => {
    const providerFactory: ClientConfig<
      Doc,
      JsonDoc,
      Operations
    >["local"]["provider"] = (identity) => indexedDBProvider(identity);
    return vi.fn(providerFactory);
  };

  const cacheDebounceTestDoc = (client: DebounceTestClient, docId: string) => {
    const doc = { docId };
    client["_docsCache"].set(docId, {
      promisedDoc: Promise.resolve(doc),
      activeSyncAttempt: undefined,
      refCount: 1,
      localVersion: 0,
      type: "test",
      queryResult: {
        status: "success",
        fetchStatus: "idle",
        data: { doc, docId },
      },
      queryListeners: new Set(),
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

    test.each([{ mode: "throw" }, { mode: "reject" }])(
      "surfaces a token provider $mode as a connection error",
      async ({ mode }) => {
        const tokenError = new Error(`token ${mode}`);
        const getToken = () => {
          if (mode === "throw") throw tokenError;
          return Promise.reject(tokenError);
        };
        socketMockState.autoIdentity = false;
        const client = new DocSyncClient({
          server: {
            url: "ws://localhost:8081",
            auth: { mode: "token", getToken },
          },
          docBinding: DocNodeBinding([
            { type: "test", extensions: [{ nodes: [TestNode, ChildNode] }] },
          ]),
          local: { provider: indexedDBProvider },
        });
        setSocketState(client, { active: true, connected: false });
        const callback = createCallback();
        subscribeToDoc(
          client,
          { type: "test", id: ulid().toLowerCase(), createIfMissing: true },
          callback,
        );

        const options = ioMock.mock.calls.at(-1)?.[1];
        if (!options || typeof options.auth !== "function") {
          throw new Error("Expected socket auth callback");
        }
        const authCallback = vi.fn();
        options.auth(authCallback);

        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0])
          .toMatchObject({
            status: "error",
            fetchStatus: "paused",
            error: {
              type: "ConnectionError",
              message: tokenError.message,
              cause: tokenError,
            },
          });
        expect(authCallback).not.toHaveBeenCalled();
      },
    );

    test("ignores a token failure after a manual disconnect", async () => {
      socketMockState.autoIdentity = false;
      let rejectToken: ((reason?: unknown) => void) | undefined;
      const client = new DocSyncClient({
        server: {
          url: "ws://localhost:8081",
          auth: {
            mode: "token",
            getToken: () =>
              new Promise<string>((_resolve, reject) => {
                rejectToken = reject;
              }),
          },
        },
        docBinding: DocNodeBinding([
          { type: "test", extensions: [{ nodes: [TestNode, ChildNode] }] },
        ]),
        local: { provider: indexedDBProvider },
      });
      setSocketState(client, { active: true, connected: false });
      const callback = createCallback();
      subscribeToDoc(
        client,
        { type: "test", id: ulid().toLowerCase(), createIfMissing: true },
        callback,
      );

      const options = ioMock.mock.calls.at(-1)?.[1];
      if (!options || typeof options.auth !== "function") {
        throw new Error("Expected socket auth callback");
      }
      const authCallback = vi.fn();
      options.auth(authCallback);
      await flushMicrotasks();
      if (!rejectToken) throw new Error("Expected pending token request");

      client.disconnect();
      rejectToken(new Error("too late"));
      await flushMicrotasks();

      expect(callback.mock.calls.at(-1)?.[0]).toStrictEqual({
        status: "pending",
        fetchStatus: "paused",
      });
      expect(authCallback).not.toHaveBeenCalled();
    });

    test("uses cached identity namespace and sends claimed user ID", async () => {
      socketMockState.autoIdentity = false;

      const providerFactory = createIndexedDBProviderSpy();
      const client = createClientWithProvider(providerFactory, "cached-user");
      await client["_localPromise"];

      const options = ioMock.mock.calls.at(-1)?.[1];
      if (!options || typeof options.auth !== "function") {
        throw new Error("Expected socket auth callback");
      }

      let authPayload: SocketAuthPayload | undefined;
      options.auth((payload) => {
        authPayload = payload;
      });
      await flushMicrotasks();

      expect(authPayload).toMatchObject({
        clientId: client["_clientId"],
        claimedUserId: "cached-user",
      });
      expect(
        providerFactory.mock.calls.map(([identity]) => identity),
      ).toStrictEqual([{ userId: "cached-user" }]);
      expect((await client["_localPromise"]).identity).toStrictEqual({
        userId: "cached-user",
      });
    });

    test("does not sync local operations while socket is disconnected", async () => {
      socketMockState.autoIdentity = false;

      const providerFactory = createIndexedDBProviderSpy();
      const client = createClientWithProvider(providerFactory, "offline-user");
      await client["_localPromise"];
      client["_socket"].connected = false;

      const callback = createCallback();
      subscribeToDoc(
        client,
        { type: "test", id: ulid().toLowerCase(), createIfMissing: true },
        callback,
      );
      await expect.poll(() => getSuccessData(callback)).toBeDefined();

      const loadedDoc = getSuccessData(callback)?.doc;
      if (!loadedDoc) {
        throw new Error("Expected cached document to load");
      }

      loadedDoc.root.append(loadedDoc.createNode(ChildNode));
      await flushMicrotasks();

      const emitMock = getSocketEmitMock(client);
      expect(emitMock.mock.calls.some(([event]) => event === "sync")).toBe(
        false,
      );
    });

    test("opens provider when server identity arrives", async () => {
      socketMockState.identityPayload = { userId: "plain-user" };

      const providerFactory = createIndexedDBProviderSpy();
      const client = createClientWithProvider(providerFactory);

      await expect
        .poll(async () => (await client["_localPromise"]).identity.userId)
        .toBe("plain-user");

      expect(localStorage.getItem(LOCAL_IDENTITY_KEY)).toBe("plain-user");
      expect(
        providerFactory.mock.calls.map(([identity]) => identity),
      ).toStrictEqual([{ userId: "plain-user" }]);
    });

    test("keeps same local namespace when verified identity matches", async () => {
      socketMockState.identityPayload = { userId: "same-user" };
      const providerFactory = createIndexedDBProviderSpy();

      const client = createClientWithProvider(providerFactory, "same-user");
      await client["_localPromise"];
      await flushMicrotasks();

      await expect
        .poll(() => localStorage.getItem(LOCAL_IDENTITY_KEY))
        .toBe("same-user");
      expect(providerFactory).toHaveBeenCalledTimes(1);
      expect((await client["_localPromise"]).identity).toStrictEqual({
        userId: "same-user",
      });
      expect(
        providerFactory.mock.calls.map(([identity]) => identity),
      ).toStrictEqual([{ userId: "same-user" }]);
    });

    test("clearLocalIdentity removes the cached identity only", async () => {
      socketMockState.autoIdentity = false;

      const providerFactory = createIndexedDBProviderSpy();
      const client = createClientWithProvider(providerFactory, "logout-user");
      await client["_localPromise"];

      expect(localStorage.getItem(LOCAL_IDENTITY_KEY)).toBe("logout-user");

      client.clearLocalIdentity();

      expect(localStorage.getItem(LOCAL_IDENTITY_KEY)).toBeNull();
      expect((await client["_localPromise"]).identity).toStrictEqual({
        userId: "logout-user",
      });
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
        subscribeToDoc(
          client,
          { type: "test", id: ulid().toLowerCase(), createIfMissing: true },
          callback,
        );

        await expect.poll(() => constructorSpy.mock.calls.length).toBe(1);
        // BroadcastChannel name should be user-specific: "docsync:{userId}"
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const channelName = constructorSpy.mock.calls[0]?.[0];
        expect(channelName).toBe("docsync:mock-user");
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

        subscribeToDoc(
          client,
          { type: "test", id: ulid().toLowerCase(), createIfMissing: true },
          callback,
        );
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
          auth: { mode: "token", getToken: () => "test-token" },
        },
        docBinding,
        local: { provider: indexedDBProvider },
      };
      const client = new DocSyncClient(config);
      await client["_localPromise"];

      const docId = ulid().toLowerCase();
      let latestResult: QueryResult<DocData<FakeDoc>> | undefined;
      subscribeToDoc(
        client,
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
    test("persists collaborative local operations every fixed IDB debounce while server sync waits for collab debounce", async () => {
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
        cacheDebounceTestDoc(client, "doc-1");
        client["_collabDocIds"].add("doc-1");

        client.onLocalOperations({
          docId: "doc-1",
          operations: [{ value: "A" }],
        });
        await vi.advanceTimersByTimeAsync(49);
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

        const emitMock = getSocketEmitMock(client);
        expect(emitMock).not.toHaveBeenCalledWith(
          "sync",
          expect.objectContaining({ docId: "doc-1" }),
          expect.any(Function),
        );

        await vi.advanceTimersByTimeAsync(949);
        await flushMicrotasks();
        expect(emitMock).not.toHaveBeenCalledWith(
          "sync",
          expect.objectContaining({ docId: "doc-1" }),
          expect.any(Function),
        );

        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();

        expect(emitMock).toHaveBeenCalledWith(
          "sync",
          expect.objectContaining({ docId: "doc-1" }),
          expect.any(Function),
        );
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    test("persists single-client local operations every fixed IDB debounce", async () => {
      vi.useFakeTimers();

      try {
        const saveOperations = vi.fn<SaveOperations>(() =>
          Promise.resolve(undefined),
        );
        const client = createDebounceTestClient({
          saveOperations,
          timing: { collabMaxDebounce: 50, singleClientMaxDebounce: 1000 },
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
        await vi.advanceTimersByTimeAsync(9);
        await flushMicrotasks();
        expect(saveOperations).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();

        expect(saveOperations).toHaveBeenCalledOnce();
        expect(saveOperations).toHaveBeenCalledWith({
          docId: "doc-1",
          operations: [{ value: "A" }, { value: "B" }],
        });

        client.onLocalOperations({
          docId: "doc-1",
          operations: [{ value: "C" }],
        });
        await vi.advanceTimersByTimeAsync(49);
        await flushMicrotasks();
        expect(saveOperations).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();

        expect(saveOperations).toHaveBeenCalledTimes(2);
        expect(saveOperations).toHaveBeenLastCalledWith({
          docId: "doc-1",
          operations: [{ value: "C" }],
        });
        client.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });

    test("syncs saved single-client operations when a collaborator appears", async () => {
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

        await vi.advanceTimersByTimeAsync(50);
        await flushMicrotasks();

        expect(saveOperations).toHaveBeenCalledWith({
          docId,
          operations: [{ value: "A" }],
        });

        const emitMock = getSocketEmitMock(client);
        expect(emitMock).not.toHaveBeenCalledWith(
          "sync",
          expect.objectContaining({ docId }),
          expect.any(Function),
        );

        await vi.advanceTimersByTimeAsync(2949);
        await flushMicrotasks();
        expect(emitMock).not.toHaveBeenCalledWith(
          "sync",
          expect.objectContaining({ docId }),
          expect.any(Function),
        );

        emitMockedCollaboration(client, { docId, hasCollaborators: true });
        await flushMicrotasks();

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

  describe("getDocObserver types", () => {
    type DocResult = QueryResult<DocData<Doc>>;
    type MaybeDocResult = QueryResult<DocData<Doc> | undefined>;

    // These tests only verify types at compile time, no runtime assertions needed
    test("callback receives correct types based on args", () => {
      const client = createClient();
      const id = ulid().toLowerCase();

      // with id, without createIfMissing → MaybeDocResult
      subscribeToDoc(client, { type: "test", id }, (result) => {
        expectTypeOf(result).toEqualTypeOf<MaybeDocResult>();
      });

      // with id, createIfMissing: true → DocResult
      subscribeToDoc(
        client,
        { type: "test", id, createIfMissing: true },
        (result) => {
          expectTypeOf(result).toEqualTypeOf<DocResult>();
        },
      );

      // with id, createIfMissing: false → MaybeDocResult
      subscribeToDoc(
        client,
        { type: "test", id, createIfMissing: false },
        (result) => {
          expectTypeOf(result).toEqualTypeOf<MaybeDocResult>();
        },
      );
    });

    test("type errors for invalid arguments", () => {
      // These are compile-time checks only - we use a function that's never called
      // to avoid runtime execution while still getting TypeScript to check the types
      const typeCheck = (client: ReturnType<typeof createClient>) => {
        // @ts-expect-error - type is required (even with id)
        client.getDocObserver({ id: "123" });

        // @ts-expect-error - type is required (even with createIfMissing and id)
        client.getDocObserver({ createIfMissing: true, id: "123" });

        // @ts-expect-error - id is required
        client.getDocObserver({ type: "test" });

        // @ts-expect-error - id is required
        client.getDocObserver({ type: "test", createIfMissing: false });

        // @ts-expect-error - id is required
        client.getDocObserver({ type: "test", createIfMissing: true });
      };

      // Verify the function exists (never called, just for type checking)
      expect(typeCheck).toBeDefined();
    });

    test("QueryResult has expected structure", () => {
      expectTypeOf<DocResult>().toEqualTypeOf<
        | {
            status: "pending";
            fetchStatus: "fetching" | "paused" | "idle";
            data?: never;
            error?: never;
          }
        | {
            status: "success";
            fetchStatus: "fetching" | "paused" | "idle";
            data: DocData<Doc>;
            error?: never;
          }
        | {
            status: "error";
            fetchStatus: "fetching" | "paused" | "idle";
            data?: DocData<Doc> | undefined;
            error: Error;
          }
      >();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // getDocObserver tests
  // ──────────────────────────────────────────────────────────────────────────

  describe("getDocObserver", () => {
    const createDocWithChild = (client: ReturnType<typeof createClient>) => {
      const docId = ulid().toLowerCase();
      const { doc } = client["_docBinding"].create("test", docId);
      doc.root.append(doc.createNode(ChildNode));
      doc.forceCommit();
      return {
        docId,
        doc,
        serializedDoc: client["_docBinding"].serialize(doc),
      };
    };

    describe("Get existing document", () => {
      test("should stay lazy until its first subscriber and share one document subscription", async () => {
        const client = createClient();
        const docId = ulid().toLowerCase();
        const observer = client.getDocObserver({ type: "test", id: docId });

        expect(observer.getSnapshot()).toStrictEqual({
          status: "pending",
          fetchStatus: "fetching",
        });
        expect(client["_docsCache"].has(docId)).toBe(false);

        const unsubscribeFirst = observer.subscribe(() => undefined);
        const unsubscribeSecond = observer.subscribe(() => undefined);
        expect(client["_docsCache"].get(docId)?.refCount).toBe(1);

        unsubscribeFirst();
        expect(client["_docsCache"].get(docId)?.refCount).toBe(1);
        unsubscribeSecond();
        await expect.poll(() => client["_docsCache"].has(docId)).toBe(false);
      });

      test("should emit pending status initially", () => {
        const client = createClient();
        const callback = createCallback();

        subscribeToDoc(client, { type: "test", id: "test-id" }, callback);

        expect(callback).toHaveBeenCalledWith({
          status: "pending",
          fetchStatus: "fetching",
        });
      });

      test("should remain fetching while the initial connection is active", () => {
        const client = createClient();
        const callback = createCallback();

        setSocketState(client, { active: true, connected: false });
        subscribeToDoc(client, { type: "test", id: "test-id" }, callback);

        expect(callback).toHaveBeenCalledWith({
          status: "pending",
          fetchStatus: "fetching",
        });
      });

      test("should pause an idle query after a manual disconnect", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        setSocketState(client, { active: false, connected: false });
        emitMockedSocketEvent(client, "disconnect", "io client disconnect");

        expect(callback.mock.calls.at(-1)?.[0]).toMatchObject({
          status: "success",
          fetchStatus: "paused",
        });
      });

      test("should pause a transient connection failure without reporting an error", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        setSocketState(client, { active: true, connected: false });
        emitMockedSocketEvent(
          client,
          "connect_error",
          new Error("transport unavailable"),
        );

        expect(callback.mock.calls.at(-1)?.[0]).toMatchObject({
          status: "success",
          fetchStatus: "paused",
        });
      });

      test("should preserve local data with a permanent connection error", async () => {
        const client = createClient();
        const callback = createCallback();
        const connectionError = new Error("Authentication failed");
        const docId = ulid().toLowerCase();

        setSocketState(client, { active: false, connected: false });
        emitMockedSocketEvent(client, "connect_error", connectionError);
        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );

        expect(callback.mock.calls[0]?.[0]).toMatchObject({
          status: "error",
          fetchStatus: "paused",
          error: { type: "ConnectionError", message: "Authentication failed" },
        });
        expect(callback.mock.calls[0]?.[0].error).toBeInstanceOf(DocSyncError);
        expect(callback.mock.calls[0]?.[0].error?.cause).toBe(connectionError);
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0])
          .toMatchObject({
            status: "error",
            fetchStatus: "paused",
            error: { type: "ConnectionError" },
            data: { docId },
          });
      });

      test("should report a server-initiated disconnect as an error", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        setSocketState(client, { active: false, connected: false });
        emitMockedSocketEvent(client, "disconnect", "io server disconnect");

        expect(callback.mock.calls.at(-1)?.[0]).toMatchObject({
          status: "error",
          fetchStatus: "paused",
          data: { docId },
          error: { type: "ConnectionError" },
        });
        expect(callback.mock.calls.at(-1)?.[0].error?.message).toContain(
          "io server disconnect",
        );
      });

      test("should recover a permanent connection error after reconnecting", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();

        setSocketState(client, { active: false, connected: false });
        emitMockedSocketEvent(
          client,
          "connect_error",
          new Error("Authentication failed"),
        );
        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].status)
          .toBe("error");

        setSocketState(client, { active: true, connected: true });
        emitMockedSocketEvent(client, "connect");

        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0])
          .toMatchObject({ status: "success", fetchStatus: "idle" });
      });

      test("observer should report the state a new subscription starts from", () => {
        const client = createClient();

        expect(
          client.getDocObserver({ type: "test", id: "unknown" }).getSnapshot(),
        ).toStrictEqual({ status: "pending", fetchStatus: "fetching" });

        setSocketState(client, { active: false, connected: false });
        emitMockedSocketEvent(
          client,
          "connect_error",
          new Error("Authentication failed"),
        );

        expect(
          client.getDocObserver({ type: "test", id: "unknown" }).getSnapshot(),
        ).toMatchObject({
          status: "error",
          fetchStatus: "paused",
          error: { type: "ConnectionError" },
        });
      });

      test("observer should return the cached result of a loaded document", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        // Same object the subscription holds — a read, not a new query.
        expect(
          client.getDocObserver({ type: "test", id: docId }).getSnapshot(),
        ).toBe(callback.mock.calls.at(-1)?.[0]);
        expect(client["_docsCache"].get(docId)?.refCount).toBe(1);
      });

      test("should report the same fetch status for every subscription during a transient failure", async () => {
        const client = createClient();
        const loadedCallback = createCallback();
        const lateCallback = createCallback();

        subscribeToDoc(
          client,
          { type: "test", id: ulid().toLowerCase(), createIfMissing: true },
          loadedCallback,
        );
        await expect
          .poll(() => loadedCallback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        setSocketState(client, { active: true, connected: false });
        emitMockedSocketEvent(
          client,
          "connect_error",
          new Error("transport unavailable"),
        );
        expect(loadedCallback.mock.calls.at(-1)?.[0].fetchStatus).toBe(
          "paused",
        );

        subscribeToDoc(
          client,
          { type: "test", id: ulid().toLowerCase(), createIfMissing: true },
          lateCallback,
        );

        expect(lateCallback.mock.calls[0]?.[0]).toStrictEqual({
          status: "pending",
          fetchStatus: "paused",
        });
      });

      test("should pause queries when disconnecting before the connection is established", () => {
        const client = createClient();
        const callback = createCallback();

        setSocketState(client, { active: true, connected: false });
        subscribeToDoc(client, { type: "test", id: "test-id" }, callback);
        expect(callback.mock.calls.at(-1)?.[0].fetchStatus).toBe("fetching");

        client.disconnect();

        expect(callback.mock.calls.at(-1)?.[0]).toStrictEqual({
          status: "pending",
          fetchStatus: "paused",
        });
      });

      test("should keep a permanent connection error visible while reconnecting", () => {
        const client = createClient();
        const callback = createCallback();
        const connectionError = new Error("Authentication failed");

        setSocketState(client, { active: false, connected: false });
        emitMockedSocketEvent(client, "connect_error", connectionError);

        client.connect();
        setSocketState(client, { active: true, connected: false });
        subscribeToDoc(client, { type: "test", id: "test-id" }, callback);

        expect(callback.mock.calls[0]?.[0]).toMatchObject({
          status: "error",
          fetchStatus: "fetching",
          error: { type: "ConnectionError", cause: connectionError },
        });
      });

      test("should leave an already connected client and its queries unchanged", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");
        const settledResult = callback.mock.calls.at(-1)?.[0];
        const connect = getSocketConnectMock(client);

        client.connect();

        expect(connect).not.toHaveBeenCalled();
        expect(callback.mock.calls.at(-1)?.[0]).toBe(settledResult);
      });

      test("should preserve paused state when starting the socket throws", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");
        setSocketState(client, { active: false, connected: false });
        emitMockedSocketEvent(client, "disconnect", "io client disconnect");
        getSocketConnectMock(client).mockImplementationOnce(() => {
          throw new Error("socket start failed");
        });

        expect(() => client.connect()).toThrow("socket start failed");
        expect(client["_connectionFetchStatus"]).toBe("paused");
        expect(callback.mock.calls.at(-1)?.[0].fetchStatus).toBe("paused");
      });

      test("should update every query before notifying reconnect listeners", async () => {
        const client = createClient();
        const firstId = ulid().toLowerCase();
        const secondId = ulid().toLowerCase();
        const firstObserver = client.getDocObserver({
          type: "test",
          id: firstId,
          createIfMissing: true,
        });
        const secondObserver = client.getDocObserver({
          type: "test",
          id: secondId,
          createIfMissing: true,
        });
        firstObserver.subscribe(() => undefined);
        secondObserver.subscribe(() => undefined);
        await expect
          .poll(() => secondObserver.getSnapshot().fetchStatus)
          .toBe("idle");

        setSocketState(client, { active: false, connected: false });
        emitMockedSocketEvent(client, "disconnect", "io client disconnect");
        firstObserver.subscribe(() => {
          if (firstObserver.getSnapshot().fetchStatus === "fetching") {
            expect(secondObserver.getSnapshot().fetchStatus).toBe("fetching");
            throw new Error("listener failed");
          }
        });
        let secondListenerSawFirstStatus: string | undefined;
        secondObserver.subscribe(() => {
          secondListenerSawFirstStatus =
            firstObserver.getSnapshot().fetchStatus;
        });

        expect(() => client.connect()).toThrow("listener failed");
        expect(getSocketConnectMock(client)).toHaveBeenCalledOnce();
        expect(firstObserver.getSnapshot().fetchStatus).toBe("fetching");
        expect(secondObserver.getSnapshot().fetchStatus).toBe("fetching");
        expect(secondListenerSawFirstStatus).toBe("fetching");
      });

      test("should resume loaded queries when reconnecting, not just new ones", async () => {
        const client = createClient();
        const loadedCallback = createCallback();
        const lateCallback = createCallback();
        const docId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          loadedCallback,
        );
        await expect
          .poll(() => loadedCallback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        setSocketState(client, { active: false, connected: false });
        emitMockedSocketEvent(
          client,
          "connect_error",
          new Error("Authentication failed"),
        );
        expect(loadedCallback.mock.calls.at(-1)?.[0]).toMatchObject({
          status: "error",
          fetchStatus: "paused",
        });
        const visibleError = loadedCallback.mock.calls.at(-1)?.[0].error;

        client.connect();
        setSocketState(client, { active: true, connected: false });
        subscribeToDoc(
          client,
          { type: "test", id: ulid().toLowerCase(), createIfMissing: true },
          lateCallback,
        );

        // Both subscriptions share the active retry and its last known error.
        expect(loadedCallback.mock.calls.at(-1)?.[0]).toMatchObject({
          status: "error",
          fetchStatus: "fetching",
          error: visibleError,
        });
        expect(lateCallback.mock.calls[0]?.[0]).toMatchObject({
          status: "error",
          fetchStatus: "fetching",
          error: visibleError,
        });
      });

      test("should resume loaded queries synchronously on automatic reconnect", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        setSocketState(client, { active: true, connected: false });
        emitMockedSocketEvent(client, "disconnect", "transport close");
        expect(callback.mock.calls.at(-1)?.[0].fetchStatus).toBe("paused");

        setSocketState(client, { active: true, connected: true });
        emitMockedSocketEvent(client, "connect");

        // The connect event must resume existing subscriptions before the
        // asynchronous flush-and-sync work yields to another microtask.
        expect(callback.mock.calls.at(-1)?.[0].fetchStatus).toBe("fetching");
      });

      test("should keep the document instance when subscribing while an error is visible", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");
        const loadedDoc = callback.mock.calls.at(-1)?.[0].data?.doc;
        const promisedDoc = client["_docsCache"].get(docId)?.promisedDoc;

        setSocketState(client, { active: false, connected: false });
        emitMockedSocketEvent(client, "disconnect", "io server disconnect");
        expect(callback.mock.calls.at(-1)?.[0].status).toBe("error");

        const secondCallback = createCallback();
        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          secondCallback,
        );

        expect(client["_docsCache"].get(docId)?.promisedDoc).toBe(promisedDoc);
        expect(secondCallback.mock.calls[0]?.[0].data?.doc).toBe(loadedDoc);
      });

      test("should discard an older sync after the newer sync succeeds", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();
        socketMockState.deferSyncDocIds.add(docId);

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => socketMockState.deferredSyncAcks.get(docId)?.length)
          .toBe(1);
        const supersededAck = socketMockState.deferredSyncAcks.get(docId)?.[0];
        if (!supersededAck) throw new Error("Expected deferred sync ack");

        // Reconnecting starts a second sync, which settles the query first.
        socketMockState.deferSyncDocIds.delete(docId);
        emitMockedSocketEvent(client, "disconnect", "transport close");
        emitMockedSocketEvent(client, "connect");
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");
        const settledResult = callback.mock.calls.at(-1)?.[0];

        const syncEvents: unknown[] = [];
        client.on("sync", (event) => syncEvents.push(event));
        supersededAck({
          error: { type: "ValidationError", message: "too late" },
        });
        await flushMicrotasks();

        // Stale attempts do not emit events, update query state, schedule a
        // retry, or release flow control owned by a newer attempt.
        expect(syncEvents).toStrictEqual([]);
        expect(callback.mock.calls.at(-1)?.[0]).toBe(settledResult);
        expect(settledResult).toMatchObject({
          status: "success",
          fetchStatus: "idle",
        });
        expect(client["_syncRetryState"].has(docId)).toBe(false);
      });

      test("should let a newer sync succeed after the older sync fails first", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();
        const syncEvents: unknown[] = [];
        client.on("sync", (event) => syncEvents.push(event));
        socketMockState.deferSyncDocIds.add(docId);

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => socketMockState.deferredSyncAcks.get(docId)?.length)
          .toBe(1);

        emitMockedSocketEvent(client, "disconnect", "transport close");
        emitMockedSocketEvent(client, "connect");
        await expect
          .poll(() => socketMockState.deferredSyncAcks.get(docId)?.length)
          .toBe(2);

        const [supersededAck, currentAck] =
          socketMockState.deferredSyncAcks.get(docId) ?? [];
        if (!supersededAck || !currentAck) {
          throw new Error("Expected both deferred sync acks");
        }

        supersededAck({
          error: { type: "ValidationError", message: "too late" },
        });
        await flushMicrotasks();

        expect(syncEvents).toStrictEqual([]);
        expect(callback.mock.calls.at(-1)?.[0].fetchStatus).toBe("fetching");
        expect(callback.mock.calls.at(-1)?.[0].status).not.toBe("error");

        currentAck({
          data: { docId, operations: [], serializedDoc: null, clock: 0 },
        });

        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0])
          .toMatchObject({ status: "success", fetchStatus: "idle" });
        expect(
          syncEvents.some(
            (event) =>
              typeof event === "object" && event !== null && "error" in event,
          ),
        ).toBe(false);
      });

      test("should finish provider consolidation when a sync is invalidated after saving its snapshot", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        const doc = callback.mock.calls.at(-1)?.[0].data?.doc;
        if (!doc) throw new Error("Expected loaded doc");
        doc.root.append(doc.createNode(ChildNode));
        doc.forceCommit();
        await client["_flushLocalOperations"](docId, { sync: false });

        const { provider } = await client["_localPromise"];
        const transaction = provider.transaction.bind(provider);
        let interruptAfterSnapshot = true;
        const transactionSpy = vi
          .spyOn(provider, "transaction")
          .mockImplementation((mode, transactionCallback) => {
            if (mode !== "readwrite" || !interruptAfterSnapshot) {
              return transaction(mode, transactionCallback);
            }
            interruptAfterSnapshot = false;
            return transaction(mode, (ctx) =>
              transactionCallback({
                ...ctx,
                saveSerializedDoc: async (payload) => {
                  await ctx.saveSerializedDoc(payload);
                  setSocketState(client, { active: true, connected: false });
                  emitMockedSocketEvent(
                    client,
                    "disconnect",
                    "transport close",
                  );
                },
              }),
            );
          });

        try {
          await client["_sync"](docId);

          const operations = await transaction("readonly", (ctx) =>
            ctx.getOperations({ docId }),
          );
          expect(operations).toStrictEqual([]);
          expect(callback.mock.calls.at(-1)?.[0].fetchStatus).toBe("paused");
        } finally {
          transactionSpy.mockRestore();
        }
      });

      test("should return undefined when document does not exist and createIfMissing is false", async () => {
        const client = createClient();
        const callback = createCallback();

        subscribeToDoc(
          client,
          { type: "test", id: "non-existent-id" },
          callback,
        );
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0])
          .toEqual({ status: "success", fetchStatus: "idle", data: undefined });
      });

      test("should load a server-only document when createIfMissing is false", async () => {
        const client = createClient();
        const callback = createCallback();
        const serverDoc = createDocWithChild(client);

        socketMockState.syncResponses.set(serverDoc.docId, {
          data: {
            docId: serverDoc.docId,
            operations: [],
            serializedDoc: serverDoc.serializedDoc,
            clock: 0,
          },
        });

        subscribeToDoc(
          client,
          { type: "test", id: serverDoc.docId, createIfMissing: false },
          callback,
        );

        await expect
          .poll(() => {
            const latest = callback.mock.calls.at(-1)?.[0];
            return latest?.status === "success" && latest.data
              ? latest.data.doc.toJSON()
              : undefined;
          })
          .toStrictEqual(serverDoc.doc.toJSON());
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        const { provider } = await client["_localPromise"];
        const stored = await provider.transaction("readonly", (ctx) =>
          ctx.getSerializedDoc({ docId: serverDoc.docId }),
        );
        expect(stored?.serializedDoc).toStrictEqual(serverDoc.serializedDoc);
      });

      test("should return cached document when requested multiple times", async () => {
        const client = createClient();
        const callback1 = createCallback();
        const callback2 = createCallback();
        const docId = ulid().toLowerCase();

        // Create a doc first
        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback1,
        );
        await expect.poll(() => getSuccessData(callback1)).toBeDefined();
        const createdDoc = getSuccessData(callback1);

        // Request the same doc again
        subscribeToDoc(
          client,
          { type: "test", id: createdDoc!.docId },
          callback2,
        );
        await expect.poll(() => getSuccessData(callback2)).toBeDefined();
        const cachedDoc = getSuccessData(callback2);
        expect(cachedDoc?.doc).toBe(createdDoc!.doc);
      });

      test("should emit cached query state immediately", async () => {
        const client = createClient();
        const callback1 = createCallback();
        const callback2 = createCallback();
        const docId = ulid().toLowerCase();

        // Create a doc first
        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback1,
        );
        await expect.poll(() => getSuccessData(callback1)).toBeDefined();
        const createdDoc = getSuccessData(callback1);

        // Request the same doc - cache hit
        subscribeToDoc(
          client,
          { type: "test", id: createdDoc!.docId },
          callback2,
        );

        expect(callback2.mock.calls.length).toBe(1);
        expect(callback2.mock.calls[0]?.[0]?.status).toBe("success");
        expect(getSuccessData(callback2)?.doc).toBe(createdDoc!.doc);
      });
    });

    describe("Create new document", () => {
      test("should create new document with provided ID when createIfMissing is true", async () => {
        const client = createClient();
        const callback = createCallback();
        const docId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: docId, createIfMissing: true },
          callback,
        );

        await expect.poll(() => getSuccessData(callback)?.docId).toBe(docId);
      });

      test("should return unsubscribe function", () => {
        const client = createClient();
        const callback = createCallback();

        const unsubscribe = subscribeToDoc(
          client,
          { type: "test", id: ulid().toLowerCase(), createIfMissing: true },
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

        subscribeToDoc(
          client,
          { type: "test", id: customId, createIfMissing: true },
          callback,
        );
        await expect.poll(() => getSuccessData(callback)?.docId).toBe(customId);
      });

      test("createIfMissing true should promote an existing shared query", async () => {
        const client = createClient();
        const callback1 = createCallback();
        const callback2 = createCallback();
        const customId = ulid().toLowerCase();

        subscribeToDoc(client, { type: "test", id: customId }, callback1);
        subscribeToDoc(
          client,
          { type: "test", id: customId, createIfMissing: true },
          callback2,
        );

        await expect
          .poll(() => getSuccessData(callback1)?.docId)
          .toBe(customId);
        await expect
          .poll(() => getSuccessData(callback2)?.docId)
          .toBe(customId);

        const doc1 = getSuccessData(callback1)?.doc;
        const doc2 = getSuccessData(callback2)?.doc;
        expect(doc1).toBe(doc2);

        const cacheEntry = client["_docsCache"].get(customId);
        expect(cacheEntry?.refCount).toBe(2);
      });

      test("createIfMissing true should send the optimistic local snapshot to sync", async () => {
        const client = createClient();
        const callback = createCallback();
        const customId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: customId, createIfMissing: true },
          callback,
        );

        await expect.poll(() => getSuccessData(callback)).toBeDefined();
        const emitMock = getSocketEmitMock(client);
        await expect
          .poll(() =>
            emitMock.mock.calls.some(
              ([event, payload]) =>
                event === "sync" &&
                typeof payload === "object" &&
                payload !== null &&
                "serializedDoc" in payload,
            ),
          )
          .toBe(true);
      });

      test("createIfMissing true should reconcile with an existing server snapshot", async () => {
        const client = createClient();
        const callback = createCallback();
        const serverDoc = createDocWithChild(client);

        socketMockState.syncResponses.set(serverDoc.docId, {
          data: {
            docId: serverDoc.docId,
            operations: [],
            serializedDoc: serverDoc.serializedDoc,
            clock: 0,
          },
        });

        subscribeToDoc(
          client,
          { type: "test", id: serverDoc.docId, createIfMissing: true },
          callback,
        );

        await expect
          .poll(() =>
            callback.mock.calls.some(
              ([result]) =>
                result.status === "success" &&
                result.fetchStatus === "fetching",
            ),
          )
          .toBe(true);
        await expect
          .poll(() => {
            const latest = callback.mock.calls.at(-1)?.[0];
            return latest?.status === "success" && latest.data
              ? latest.data.doc.toJSON()
              : undefined;
          })
          .toStrictEqual(serverDoc.doc.toJSON());
        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        const { provider } = await client["_localPromise"];
        const stored = await provider.transaction("readonly", (ctx) =>
          ctx.getSerializedDoc({ docId: serverDoc.docId }),
        );
        expect(stored?.serializedDoc).toStrictEqual(serverDoc.serializedDoc);
      });

      test("createIfMissing true should invalidate the optimistic doc after reconciling with a server snapshot", async () => {
        const client = createClient();
        const callback = createCallback();
        const serverDoc = createDocWithChild(client);

        socketMockState.syncResponses.set(serverDoc.docId, {
          data: {
            docId: serverDoc.docId,
            operations: [],
            serializedDoc: serverDoc.serializedDoc,
            clock: 0,
          },
        });

        subscribeToDoc(
          client,
          { type: "test", id: serverDoc.docId, createIfMissing: true },
          callback,
        );

        await expect
          .poll(() =>
            callback.mock.calls.find(
              ([result]) =>
                result.status === "success" &&
                result.fetchStatus === "fetching",
            ),
          )
          .toBeDefined();

        const optimisticResult = callback.mock.calls.find(
          ([result]) =>
            result.status === "success" && result.fetchStatus === "fetching",
        )?.[0];
        if (
          optimisticResult?.status !== "success" ||
          optimisticResult.data === undefined
        ) {
          throw new Error("Expected optimistic doc result");
        }
        const optimisticDoc = optimisticResult.data.doc;

        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        await Promise.resolve();

        expect(() => {
          const child = optimisticDoc.createNode(ChildNode);
          optimisticDoc.root.append(child);
        }).toThrow();
      });

      test("should emit local success while network fetch is still active", async () => {
        const client = createClient();
        const callback = createCallback();
        const customId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: customId, createIfMissing: true },
          callback,
        );

        await expect
          .poll(() =>
            callback.mock.calls.some(
              ([result]) =>
                result.status === "success" &&
                result.fetchStatus === "fetching",
            ),
          )
          .toBe(true);
      });

      test("should emit local success as paused when disconnected", async () => {
        const client = createClient();
        const callback = createCallback();
        const customId = ulid().toLowerCase();

        setSocketState(client, { active: true, connected: false });
        emitMockedSocketEvent(client, "connect_error", new Error("offline"));
        subscribeToDoc(
          client,
          { type: "test", id: customId, createIfMissing: true },
          callback,
        );

        await expect
          .poll(() =>
            callback.mock.calls.some(
              ([result]) =>
                result.status === "success" && result.fetchStatus === "paused",
            ),
          )
          .toBe(true);
      });

      test("should emit a new result object when network settles after local success", async () => {
        const client = createClient();
        const callback = createCallback();
        const customId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: customId, createIfMissing: true },
          callback,
        );

        await expect
          .poll(
            () =>
              callback.mock.calls.find(
                ([result]) =>
                  result.status === "success" &&
                  result.fetchStatus === "fetching",
              )?.[0],
          )
          .toBeDefined();
        const localResult = callback.mock.calls.find(
          ([result]) =>
            result.status === "success" && result.fetchStatus === "fetching",
        )?.[0];

        await expect
          .poll(() => callback.mock.calls.at(-1)?.[0].fetchStatus)
          .toBe("idle");

        expect(callback.mock.calls.at(-1)?.[0]).not.toBe(localResult);
      });
    });

    describe("Sync vs async behavior", () => {
      test("should emit pending before success when creating by id", async () => {
        const client = createClient();
        const callback = createCallback();
        const customId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: customId, createIfMissing: true },
          callback,
        );

        expect(callback.mock.calls[0]?.[0]?.status).toBe("pending");
        await expect.poll(() => getSuccessData(callback)?.docId).toBe(customId);
      });

      test("should emit pending before success when fetching by id", async () => {
        const client = createClient();
        const callback = createCallback();
        const customId = ulid().toLowerCase();

        subscribeToDoc(client, { type: "test", id: customId }, callback);

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
        const createdId = ulid().toLowerCase();

        const unsubscribe = subscribeToDoc(
          client,
          { type: "test", id: createdId, createIfMissing: true },
          callback,
        );
        await expect.poll(() => getSuccessData(callback)).toBeDefined();
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
        const createdId = ulid().toLowerCase();

        // First subscription creates the doc
        const unsubscribe1 = subscribeToDoc(
          client,
          { type: "test", id: createdId, createIfMissing: true },
          callback1,
        );
        await expect.poll(() => getSuccessData(callback1)).toBeDefined();
        const doc = getSuccessData(callback1)!.doc;
        const docId = getSuccessData(callback1)!.docId;

        // Second subscription to same doc
        const unsubscribe2 = subscribeToDoc(
          client,
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
        const createdId = ulid().toLowerCase();

        // Create doc
        subscribeToDoc(
          client,
          { type: "test", id: createdId, createIfMissing: true },
          callback1,
        );
        await expect.poll(() => getSuccessData(callback1)).toBeDefined();
        const docId = getSuccessData(callback1)!.docId;

        const cache = client["_docsCache"];
        expect(cache.get(docId)?.refCount).toBe(1);

        // Second subscription
        subscribeToDoc(client, { type: "test", id: docId }, callback2);
        await expect.poll(() => cache.get(docId)?.refCount).toBe(2);

        // Third subscription
        subscribeToDoc(client, { type: "test", id: docId }, callback3);
        await expect.poll(() => cache.get(docId)?.refCount).toBe(3);
      });

      test("should share same doc instance across multiple subscriptions", async () => {
        const client = createClient();
        const callback1 = createCallback();
        const callback2 = createCallback();
        const createdId = ulid().toLowerCase();

        // Create doc
        subscribeToDoc(
          client,
          { type: "test", id: createdId, createIfMissing: true },
          callback1,
        );
        await expect.poll(() => getSuccessData(callback1)).toBeDefined();
        const doc1 = getSuccessData(callback1)!.doc;

        // Second subscription
        subscribeToDoc(
          client,
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
        const createdId = ulid().toLowerCase();

        // Create doc
        subscribeToDoc(
          client,
          { type: "test", id: createdId, createIfMissing: true },
          callback,
        );
        await expect.poll(() => getSuccessData(callback)).toBeDefined();
        const doc = getSuccessData(callback)!.doc;

        const initialCallCount = callback.mock.calls.length;

        // Trigger a document change
        doc.root.append(doc.createNode(ChildNode));
        // Callback should NOT be called on doc changes (poll until stable)
        await expect
          .poll(() => callback.mock.calls.length)
          .toBe(initialCallCount);
      });
    });

    describe("Concurrency", () => {
      test("should share promise when multiple requests for same doc happen simultaneously", async () => {
        const client = createClient();
        const callback1 = createCallback();
        const callback2 = createCallback();
        const customId = ulid().toLowerCase();

        // Two simultaneous requests for the same non-existent doc
        subscribeToDoc(
          client,
          { type: "test", id: customId, createIfMissing: true },
          callback1,
        );
        subscribeToDoc(
          client,
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

    test("should expose a permanent sync rejection without retrying", async () => {
      const client = createClient();
      const callback = createCallback();
      const docId = ulid().toLowerCase();
      socketMockState.syncResponses.set(docId, {
        error: { type: "AuthorizationError", message: "Access denied" },
      });

      subscribeToDoc(
        client,
        { type: "test", id: docId, createIfMissing: true },
        callback,
      );

      await expect
        .poll(() => callback.mock.calls.at(-1)?.[0])
        .toMatchObject({
          status: "error",
          fetchStatus: "idle",
          data: { docId },
          error: { name: "AuthorizationError", message: "Access denied" },
        });
      const syncCalls = getSocketEmitMock(client).mock.calls.filter(
        ([event]) => event === "sync",
      );
      expect(syncCalls).toHaveLength(1);
    });

    test("should run a queued sync after a permanent rejection", async () => {
      const client = createClient();
      const callback = createCallback();
      const docId = ulid().toLowerCase();
      socketMockState.deferSyncDocIds.add(docId);

      subscribeToDoc(
        client,
        { type: "test", id: docId, createIfMissing: true },
        callback,
      );
      await expect
        .poll(() => socketMockState.deferredSyncAcks.get(docId)?.length)
        .toBe(1);

      await client["_sync"](docId);
      expect(client["_pushStatusByDocId"].get(docId)).toBe(
        "pushing-with-pending",
      );

      const rejectedAck = socketMockState.deferredSyncAcks.get(docId)?.[0];
      if (!rejectedAck) throw new Error("Expected deferred sync ack");
      rejectedAck({
        error: { type: "AuthorizationError", message: "Access denied" },
      });

      await expect
        .poll(() => socketMockState.deferredSyncAcks.get(docId)?.length)
        .toBe(2);
      expect(callback.mock.calls.at(-1)?.[0]).toMatchObject({
        status: "success",
        fetchStatus: "fetching",
      });
      expect(callback.mock.calls.at(-1)?.[0].error).toBeUndefined();

      const queuedAck = socketMockState.deferredSyncAcks.get(docId)?.[1];
      if (!queuedAck) throw new Error("Expected queued sync ack");
      socketMockState.deferSyncDocIds.delete(docId);
      queuedAck({
        data: { docId, operations: [], serializedDoc: null, clock: 0 },
      });

      await expect
        .poll(() => callback.mock.calls.at(-1)?.[0])
        .toMatchObject({ status: "success", fetchStatus: "idle" });
    });

    test("should not stop other documents from syncing after a rejection", async () => {
      const client = createClient();
      const rejectedCallback = createCallback();
      const healthyCallback = createCallback();
      const rejectedDocId = ulid().toLowerCase();
      const healthyDocId = ulid().toLowerCase();
      socketMockState.syncResponses.set(rejectedDocId, {
        error: { type: "AuthorizationError", message: "Access denied" },
      });

      subscribeToDoc(
        client,
        { type: "test", id: rejectedDocId, createIfMissing: true },
        rejectedCallback,
      );
      await expect
        .poll(() => rejectedCallback.mock.calls.at(-1)?.[0].status)
        .toBe("error");

      subscribeToDoc(
        client,
        { type: "test", id: healthyDocId, createIfMissing: true },
        healthyCallback,
      );

      await expect
        .poll(() => healthyCallback.mock.calls.at(-1)?.[0])
        .toMatchObject({ status: "success", fetchStatus: "idle" });
      // The rejected document keeps its own error without leaking into the
      // other document's query.
      expect(rejectedCallback.mock.calls.at(-1)?.[0]).toMatchObject({
        status: "error",
        error: { type: "AuthorizationError" },
      });
    });

    test("should retry a database error with backoff until it succeeds", async () => {
      const client = createClient();
      const callback = createCallback();
      const docId = ulid().toLowerCase();
      socketMockState.syncResponses.set(docId, {
        error: { type: "DatabaseError", message: "database unavailable" },
      });

      subscribeToDoc(
        client,
        { type: "test", id: docId, createIfMissing: true },
        callback,
      );

      await expect
        .poll(() => callback.mock.calls.at(-1)?.[0])
        .toMatchObject({ status: "success", data: { docId } });
      expect(callback.mock.calls.at(-1)?.[0].error).toBeUndefined();

      const syncCallsAfterFailure = getSocketEmitMock(client).mock.calls.filter(
        ([event]) => event === "sync",
      ).length;
      expect(syncCallsAfterFailure).toBe(1);
      // A scheduled retry is still network work, so the query must not claim
      // it has settled while the backoff is pending.
      expect(callback.mock.calls.at(-1)?.[0].fetchStatus).toBe("fetching");
      expect(
        callback.mock.calls.some(
          ([result]) =>
            result.status === "error" && result.fetchStatus === "idle",
        ),
      ).toBe(false);

      // The retry is scheduled, not immediate, so a server outage cannot turn
      // into a hot loop.
      await expect
        .poll(
          () =>
            getSocketEmitMock(client).mock.calls.filter(
              ([event]) => event === "sync",
            ).length,
        )
        .toBeGreaterThan(1);

      socketMockState.syncResponses.delete(docId);

      await expect
        .poll(() => callback.mock.calls.at(-1)?.[0])
        .toMatchObject({ status: "success", fetchStatus: "idle" });
    });

    test("should let a scheduled retry absorb a queued sync", async () => {
      const client = createClient();
      const callback = createCallback();
      const docId = ulid().toLowerCase();
      socketMockState.deferSyncDocIds.add(docId);

      subscribeToDoc(
        client,
        { type: "test", id: docId, createIfMissing: true },
        callback,
      );
      await expect
        .poll(() => socketMockState.deferredSyncAcks.get(docId)?.length)
        .toBe(1);
      await client["_sync"](docId);

      const failedAck = socketMockState.deferredSyncAcks.get(docId)?.[0];
      if (!failedAck) throw new Error("Expected deferred sync ack");
      failedAck({
        error: { type: "DatabaseError", message: "database unavailable" },
      });
      await flushMicrotasks();

      expect(socketMockState.deferredSyncAcks.get(docId)).toHaveLength(1);
      expect(client["_syncRetryState"].get(docId)?.timeout).toBeDefined();
      expect(callback.mock.calls.at(-1)?.[0]).toMatchObject({
        status: "success",
        fetchStatus: "fetching",
      });
      expect(callback.mock.calls.at(-1)?.[0].error).toBeUndefined();

      setSocketState(client, { active: true, connected: false });
      emitMockedSocketEvent(client, "disconnect", "transport close");
    });

    test("should retry a rejected sync request as a network error", async () => {
      const client = createClient();
      const callback = createCallback();
      const docId = ulid().toLowerCase();
      const networkFailure = new Error("network unavailable");
      socketMockState.syncErrors.set(docId, networkFailure);

      subscribeToDoc(
        client,
        { type: "test", id: docId, createIfMissing: true },
        callback,
      );

      await expect
        .poll(() => callback.mock.calls.at(-1)?.[0])
        .toMatchObject({
          status: "success",
          fetchStatus: "fetching",
          data: { docId },
        });
      expect(callback.mock.calls.at(-1)?.[0].error).toBeUndefined();
      expect(client["_syncRetryState"].get(docId)?.attempts).toBe(1);

      socketMockState.syncErrors.delete(docId);
      await client["_sync"](docId);

      expect(callback.mock.calls.at(-1)?.[0]).toMatchObject({
        status: "success",
        fetchStatus: "idle",
      });
      expect(client["_syncRetryState"].has(docId)).toBe(false);
    });

    test("should cancel a pending document retry when the transport disconnects", async () => {
      const client = createClient();
      const callback = createCallback();
      const docId = ulid().toLowerCase();
      socketMockState.syncResponses.set(docId, {
        error: { type: "DatabaseError", message: "database unavailable" },
      });

      subscribeToDoc(
        client,
        { type: "test", id: docId, createIfMissing: true },
        callback,
      );
      await expect
        .poll(() => client["_syncRetryState"].get(docId)?.attempts)
        .toBe(1);
      const retryTimeout = client["_syncRetryState"].get(docId)?.timeout;
      if (!retryTimeout) throw new Error("Expected retry timer");

      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      try {
        setSocketState(client, { active: true, connected: false });
        emitMockedSocketEvent(client, "disconnect", "transport close");

        expect(clearTimeoutSpy).toHaveBeenCalledWith(retryTimeout);
        expect(client["_syncRetryState"].has(docId)).toBe(false);
        expect(callback.mock.calls.at(-1)?.[0]).toMatchObject({
          status: "success",
          fetchStatus: "paused",
        });
        expect(callback.mock.calls.at(-1)?.[0].error).toBeUndefined();
      } finally {
        clearTimeoutSpy.mockRestore();
      }
    });

    test("should cancel a pending retry when a manual sync starts", async () => {
      const client = createClient();
      const callback = createCallback();
      const docId = ulid().toLowerCase();
      socketMockState.syncResponses.set(docId, {
        error: { type: "DatabaseError", message: "database unavailable" },
      });

      subscribeToDoc(
        client,
        { type: "test", id: docId, createIfMissing: true },
        callback,
      );
      await expect
        .poll(() => client["_syncRetryState"].get(docId)?.attempts)
        .toBe(1);
      const firstTimeout = client["_syncRetryState"].get(docId)?.timeout;
      if (!firstTimeout) throw new Error("Expected first retry timer");

      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      try {
        // A user edit can start a real sync before the scheduled retry fires.
        // Starting it must cancel that old timer while preserving the backoff.
        await client["_sync"](docId);

        const retryState = client["_syncRetryState"].get(docId);
        expect(retryState?.attempts).toBe(2);
        expect(retryState?.timeout).not.toBe(firstTimeout);
        expect(clearTimeoutSpy).toHaveBeenCalledWith(firstTimeout);

        socketMockState.syncResponses.delete(docId);
        await client["_sync"](docId);
        expect(client["_syncRetryState"].has(docId)).toBe(false);
      } finally {
        clearTimeoutSpy.mockRestore();
      }
    });

    test("should settle on idle after exhausting the bounded retries", async () => {
      const client = createClient();
      const callback = createCallback();
      const docId = ulid().toLowerCase();
      socketMockState.syncResponses.set(docId, {
        error: { type: "DatabaseError", message: "database unavailable" },
      });

      subscribeToDoc(
        client,
        { type: "test", id: docId, createIfMissing: true },
        callback,
      );
      await expect
        .poll(() => client["_syncRetryState"].get(docId)?.attempts)
        .toBe(1);

      for (let attempts = 2; attempts <= 8; attempts += 1) {
        await client["_sync"](docId);
        expect(client["_syncRetryState"].get(docId)?.attempts).toBe(attempts);
      }
      await client["_sync"](docId);

      expect(client["_syncRetryState"].get(docId)).toStrictEqual({
        attempts: 8,
      });
      expect(callback.mock.calls.at(-1)?.[0]).toMatchObject({
        status: "error",
        fetchStatus: "idle",
        error: { type: "DatabaseError" },
      });

      socketMockState.syncResponses.delete(docId);
      await client["_sync"](docId);
      expect(client["_syncRetryState"].has(docId)).toBe(false);
    });

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
        subscribeToDoc(
          client,
          { type: "test", id: "test-id", createIfMissing: true },
          callback,
        );
        await expect.poll(() => getErrorResult(callback)).toBeDefined();
        const errorResult = getErrorResult(callback);
        expect(errorResult?.status).toBe("error");
        expect(errorResult?.fetchStatus).toBe("idle");
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
        subscribeToDoc(
          client,
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
        subscribeToDoc(
          client,
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
        subscribeToDoc(
          client,
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
        const createdId = ulid().toLowerCase();

        subscribeToDoc(
          client,
          { type: "test", id: createdId, createIfMissing: true },
          callback,
        );
        await expect.poll(() => getSuccessData(callback)).toBeDefined();
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
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          operations: expect.anything(),
          flags: {},
          presence: {},
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
        const createdId = ulid().toLowerCase();

        // Create a doc
        subscribeToDoc(
          client,
          { type: "test", id: createdId, createIfMissing: true },
          callback,
        );
        await expect.poll(() => getSuccessData(callback)).toBeDefined();
        const doc = getSuccessData(callback)!.doc;
        const docId = getSuccessData(callback)!.docId;

        // Verify initial state - no children
        expect(doc.root.first).toBeFalsy();

        // Simulate receiving operations from another tab
        // We need to create valid operations, so we'll create them from another doc
        const tempCallback = createCallback();
        subscribeToDoc(
          client,
          { type: "test", id: ulid().toLowerCase(), createIfMissing: true },
          tempCallback,
        );
        await expect.poll(() => getSuccessData(tempCallback)).toBeDefined();
        const tempDoc = getSuccessData(tempCallback)!.doc;
        tempDoc.root.append(tempDoc.createNode(ChildNode));
        await expect.poll(() => messageHandler !== null).toBe(true);

        // Simulate a message from BroadcastChannel with empty operations
        // Operations format is [OrderedOperation[], StatePatch] - empty is [[], {}]
        messageHandler!({
          data: {
            type: "OPERATIONS",
            docId,
            source: "local-broadcast",
            operations: [[], {}],
            flags: {},
            presence: {},
          },
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
        const createdId = ulid().toLowerCase();

        // Create a doc - this will resolve _localPromise and initialize BroadcastChannel
        subscribeToDoc(
          client,
          { type: "test", id: createdId, createIfMissing: true },
          callback,
        );
        await expect.poll(() => getSuccessData(callback)).toBeDefined();
        const docId = getSuccessData(callback)!.docId;

        await expect.poll(() => messageHandler !== undefined).toBe(true);

        // Clear any previous postMessage calls from doc creation
        postMessageSpy.mockClear();

        // Simulate receiving operations from another tab (empty operations)
        // Operations format is [OrderedOperation[], StatePatch] - empty is [[], {}]
        messageHandler!({
          data: {
            type: "OPERATIONS",
            docId,
            source: "local-broadcast",
            operations: [[], {}],
            flags: {},
            presence: {},
          },
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
