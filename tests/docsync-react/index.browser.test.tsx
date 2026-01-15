import { test, expectTypeOf, expect } from "vitest";
import {
  createDocSyncClient,
  IndexedDBProvider,
} from "@docnode/docsync-react/client";
import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import type { Doc } from "docnode";
import type { DocData, QueryResult } from "@docnode/docsync/client";
import { renderHook } from "vitest-browser-react";
import { docConfig, id } from "./utils.js";

test("createDocSyncClient", async () => {
  const { useDoc } = createDocSyncClient({
    server: {
      url: "ws://localhost:8081",
      auth: {
        getToken: async () => "1234567890" as string,
      },
    },
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({
        userId: "John",
        secret: "asdasdasd",
      }),
    },
    docBinding: DocNodeBinding([docConfig]),
  });

  type DocResult = QueryResult<DocData<Doc>>;
  type MaybeDocResult = QueryResult<DocData<Doc> | undefined>;

  // Type check: useDoc returns QueryResult<Doc>
  expectTypeOf<ReturnType<typeof useDoc>>().toEqualTypeOf<MaybeDocResult>();

  // @ts-expect-error - type is required
  await renderHook(() => useDoc({ createIfMissing: true, id: "123" }));

  // with id, without createIfMissing
  // prettier-ignore
  const {result: _1} = await renderHook(
    () => useDoc({ type: "test", id: "1" }),
  );
  expectTypeOf(_1.current).toEqualTypeOf<MaybeDocResult>();
  expect(_1.current.status).toBe("loading");
  await expect
    .poll(() => _1.current.status, { interval: 100, timeout: 2000 })
    .toBe("success");
  expect(_1.current.data?.doc).toBeUndefined();

  // with id, with createIfMissing true
  // prettier-ignore
  const id2 = id.ending("2");
  const { result: _2 } = await renderHook(() =>
    useDoc({ type: "test", id: id2, createIfMissing: true }),
  );
  expectTypeOf(_2.current).toEqualTypeOf<DocResult>();
  expect(_2.current.status).toBe("loading");
  await expect
    .poll(() => _2.current.status, { interval: 100, timeout: 2000 })
    .toBe("success");
  expect(_2.current.data?.doc).toBeDefined();
  expect(_2.current.data?.id.endsWith("002")).toBe(true);
  expect(_2.current.data?.id).toBe(_2.current.data?.doc?.root.id);

  // without id, with createIfMissing true
  // prettier-ignore
  const id3 = id.ending("3");
  const { result: _3 } = await renderHook(() =>
    useDoc({ type: "test", id: id3, createIfMissing: true }),
  );
  expectTypeOf(_3.current).toEqualTypeOf<DocResult>();

  // @ts-expect-error - without id, without createIfMissing
  await renderHook(() => useDoc({ type: "test" }));

  // without id, with createIfMissing false
  // @ts-expect-error - required id
  // prettier-ignore
  await renderHook(() => useDoc({ type: "test", createIfMissing: false }));

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
