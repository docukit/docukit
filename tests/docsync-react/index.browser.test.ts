import { test, expectTypeOf } from "vitest";
import {
  createDocSyncClient,
  IndexedDBProvider,
} from "@docnode/docsync-react/client";
import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import type { Doc } from "docnode";
import type { DocData, QueryResult } from "@docnode/docsync/client";

// Type-only test - we don't actually call the hook since it can only be called in React components
test("createDocSyncClient", () => {
  const { useDoc } = createDocSyncClient({
    url: "ws://localhost:8081",
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({
        userId: "John Salchichon",
        secret: "asdasdasd",
      }),
    },
    auth: {
      getToken: async () => "1234567890" as string,
    },
    docBinding: DocNodeBinding([]),
  });

  type DocResult = QueryResult<DocData<Doc>>;
  type MaybeDocResult = QueryResult<DocData<Doc> | undefined>;

  // Type check: useDoc returns QueryResult<Doc>
  expectTypeOf<ReturnType<typeof useDoc>>().toEqualTypeOf<MaybeDocResult>();

  // @ts-expect-error - namespace is required
  useDoc({ createIfMissing: true, id: "123" });

  // with id, without createIfMissing
  const withId = useDoc({ namespace: "test", id: "123" });
  expectTypeOf(withId).toEqualTypeOf<MaybeDocResult>();

  // with id, with createIfMissing true
  // prettier-ignore
  const withIdAndCreate = useDoc({ namespace: "test", id: "123", createIfMissing: true });
  expectTypeOf(withIdAndCreate).toEqualTypeOf<DocResult>();

  // without id, with createIfMissing true
  // prettier-ignore
  const withoutIdAndCreate = useDoc({ namespace: "test", createIfMissing: true });
  expectTypeOf(withoutIdAndCreate).toEqualTypeOf<DocResult>();

  // @ts-expect-error - without id, without createIfMissing
  useDoc({ namespace: "test" });

  // without id, with createIfMissing false
  // @ts-expect-error - required id
  // prettier-ignore
  useDoc({ namespace: "test", createIfMissing: false });

  // with id, with createIfMissing false
  // prettier-ignore
  const createFalse = useDoc({ namespace: "test", id: "123", createIfMissing: false });
  expectTypeOf(createFalse).toEqualTypeOf<MaybeDocResult>();

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
