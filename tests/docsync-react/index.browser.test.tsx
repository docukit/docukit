import { expect, expectTypeOf, inject, test } from "vitest";
import {
  createDocSyncClient,
  indexedDBProvider,
} from "@docukit/docsync-react/client";
import { DocNodeBinding } from "@docukit/docsync-react/docnode";
import type { Doc } from "@docukit/docnode";
import type { DocData, QueryResult } from "@docukit/docsync/client";
import { renderHook } from "vitest-browser-react";
import { ChildNode, docConfig, id } from "./utils.js";

declare global {
  var __TEST_SERVER_PORT__: number | undefined;
}

const testServerUrl = () => {
  const injectedPort: number | undefined = inject("testServerPort");
  const port = injectedPort ?? globalThis.__TEST_SERVER_PORT__ ?? 8082;
  return `ws://localhost:${port}`;
};

const countChildren = (doc: Doc): number => {
  let count = 0;
  doc.root.children().forEach(() => {
    count += 1;
  });
  return count;
};
const reactUserId = "John";

test("createDocSyncClient", async () => {
  localStorage.setItem("docsync:localUserId", reactUserId);
  const { useDoc } = createDocSyncClient({
    server: {
      url: testServerUrl(),
      auth: { mode: "token", getToken: () => `test-token-${reactUserId}` },
    },
    local: { provider: indexedDBProvider },
    docBinding: DocNodeBinding([docConfig]),
  });

  type DocResult = QueryResult<DocData<Doc>>;
  type MaybeDocResult = QueryResult<DocData<Doc> | undefined>;

  // Type check: useDoc returns QueryResult<Doc>
  expectTypeOf<ReturnType<typeof useDoc>>().toEqualTypeOf<MaybeDocResult>();

  const typeCheck = (hook: typeof useDoc) => {
    const shouldCreate = Math.random() > 0.5;
    const dynamicCreateIfMissingResult = hook({
      type: "test",
      id: "123",
      createIfMissing: shouldCreate,
    });
    expectTypeOf(dynamicCreateIfMissingResult).toEqualTypeOf<MaybeDocResult>();

    // @ts-expect-error - type is required
    hook({ createIfMissing: true, id: "123" });

    // @ts-expect-error - id is required
    hook({ type: "test" });

    // @ts-expect-error - id is required
    hook({ type: "test", createIfMissing: false });

    // @ts-expect-error - id is required
    hook({ type: "test", createIfMissing: true });
  };
  expect(typeCheck).toBeDefined();

  // with id, without createIfMissing
  // prettier-ignore
  const {result: _1} = await renderHook(
    () => useDoc({ type: "test", id: "1" }),
  );
  expectTypeOf(_1.current).toEqualTypeOf<MaybeDocResult>();
  expect(_1.current.status).toBe("pending");
  expect(_1.current.fetchStatus).toBeDefined();
  const initialResult = _1.current;
  await expect
    .poll(() => _1.current.status, { interval: 100, timeout: 2000 })
    .toBe("success");
  expect(_1.current).not.toBe(initialResult);
  expect(_1.current.data?.doc).toBeUndefined();

  // with id, with createIfMissing true
  // prettier-ignore
  const id2 = id.ending("2");
  const { result: _2 } = await renderHook(() =>
    useDoc({ type: "test", id: id2, createIfMissing: true }),
  );
  expectTypeOf(_2.current).toEqualTypeOf<DocResult>();
  expect(_2.current.status).toBe("pending");
  await expect
    .poll(() => _2.current.status, { interval: 100, timeout: 2000 })
    .toBe("success");
  expect(_2.current.data?.doc).toBeDefined();
  expect(_2.current.data?.docId.endsWith("002")).toBe(true);
  expect(_2.current.data?.docId).toBe(_2.current.data?.doc?.root.id);

  // with id, with createIfMissing true
  // prettier-ignore
  const id3 = id.ending("3");
  const { result: _3 } = await renderHook(() =>
    useDoc({ type: "test", id: id3, createIfMissing: true }),
  );
  expectTypeOf(_3.current).toEqualTypeOf<DocResult>();

  // with id, with createIfMissing false
  // prettier-ignore
  const id4 = id.ending("4");
  const { result: _4 } = await renderHook(() =>
    useDoc({ type: "test", id: id4, createIfMissing: false }),
  );
  expectTypeOf(_4.current).toEqualTypeOf<MaybeDocResult>();

  // Type check: QueryResult<DocData<Doc>> has the expected structure
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
}, 5000);

test("client keeps own presence for debounced outgoing sync", async () => {
  localStorage.setItem("docsync:localUserId", reactUserId);
  const { useDoc, usePresence, client } = createDocSyncClient({
    server: {
      url: testServerUrl(),
      auth: { mode: "token", getToken: () => `test-token-${reactUserId}` },
    },
    local: { provider: indexedDBProvider },
    timing: { singleClientMaxDebounce: 200 },
    docBinding: DocNodeBinding([docConfig]),
  });

  if (!client) {
    throw new Error("Expected DocSyncClient to be available in browser tests");
  }

  const testId = id.ending("5");
  const { result } = await renderHook(() => {
    const doc = useDoc({ type: "test", id: testId, createIfMissing: true });
    const docId = doc.status === "success" ? doc.data.docId : undefined;
    const [presence, setPresence] = usePresence({ docId });
    return { doc, docId, presence, setPresence };
  });

  await expect
    .poll(() => result.current.doc.status, { interval: 100, timeout: 2000 })
    .toBe("success");

  const docId = result.current.docId;
  if (!docId) {
    throw new Error("Expected loaded document id");
  }

  result.current.setPresence({ anchor: 1, focus: 2 });
  const pendingPresenceState = client["_presenceDebounceState"].get(docId);
  expect(pendingPresenceState?.timeout).toBeDefined();
  expect(pendingPresenceState?.data).toStrictEqual({ anchor: 1, focus: 2 });

  const cacheEntry = client["_docsCache"].get(docId);
  if (!cacheEntry) {
    throw new Error("Expected loaded doc cache entry");
  }
  expect(cacheEntry.presence[client["_clientId"]]).toBeUndefined();

  await expect
    .poll(() => client["_presenceDebounceState"].get(docId)?.timeout, {
      interval: 50,
      timeout: 500,
    })
    .toBeUndefined();
  expect(client["_presenceDebounceState"].get(docId)?.data).toStrictEqual({
    anchor: 1,
    focus: 2,
  });
  client.disconnect();
  client["_bcHelper"]?.close();
});

test("useDoc rerenders with the server doc after replacing an optimistic local doc", async () => {
  const docId = id.ending(Date.now().toString().slice(-6));

  localStorage.removeItem("docsync:localUserId");
  const source = createDocSyncClient({
    server: {
      url: testServerUrl(),
      auth: { mode: "token", getToken: () => `test-token-source-${docId}` },
    },
    local: { provider: indexedDBProvider },
    timing: { singleClientMaxDebounce: 0 },
    docBinding: DocNodeBinding([docConfig]),
  });

  if (!source.client) {
    throw new Error("Expected source client in browser tests");
  }
  const sourceClient = source.client;
  const sourceSyncedLocalOperation: boolean[] = [];
  sourceClient.on("sync", (event) => {
    if (event.req.operations.length > 0 && event.data) {
      sourceSyncedLocalOperation.push(true);
    }
  });

  const { result: sourceResult } = await renderHook(() =>
    source.useDoc({ type: "test", id: docId, createIfMissing: true }),
  );

  await expect
    .poll(
      () =>
        sourceResult.current.status === "success"
          ? sourceResult.current.fetchStatus
          : undefined,
      { interval: 20, timeout: 2000 },
    )
    .toBe("idle");

  if (sourceResult.current.status !== "success") {
    throw new Error("Expected source doc result");
  }

  const sourceDoc = sourceResult.current.data.doc;
  const child = sourceDoc.createNode(ChildNode);
  child.state.value.set("server");
  sourceDoc.root.append(child);

  await expect
    .poll(() => sourceSyncedLocalOperation.includes(true), {
      interval: 20,
      timeout: 2000,
    })
    .toBe(true);

  sourceClient.disconnect();
  sourceClient["_bcHelper"]?.close();

  localStorage.removeItem("docsync:localUserId");
  const reader = createDocSyncClient({
    server: {
      url: testServerUrl(),
      auth: { mode: "token", getToken: () => `test-token-reader-${docId}` },
    },
    local: { provider: indexedDBProvider },
    docBinding: DocNodeBinding([docConfig]),
  });

  if (!reader.client) {
    throw new Error("Expected reader client in browser tests");
  }
  const readerClient = reader.client;

  const { result: readerResult } = await renderHook(() =>
    reader.useDoc({ type: "test", id: docId, createIfMissing: true }),
  );

  await expect
    .poll(
      () => {
        const current = readerResult.current;
        if (current.status !== "success" || current.fetchStatus !== "idle")
          return -1;

        return countChildren(current.data.doc);
      },
      { interval: 20, timeout: 2000 },
    )
    .toBe(1);

  if (readerResult.current.status !== "success") {
    throw new Error("Expected reader doc result");
  }

  readerClient.disconnect();
  readerClient["_bcHelper"]?.close();
}, 5000);
