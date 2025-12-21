import { test, expectTypeOf } from "vitest";
import {
  createDocSyncClient,
  IndexedDBProvider,
} from "@docnode/docsync-react/client";
import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import type { Doc } from "docnode";
import type { QueryResult } from "@docnode/docsync/client";

// Type-only test - we don't actually call the hook since it can only be called in React components
test("createDocSyncClient", () => {
  const { useDoc: _useDoc } = createDocSyncClient({
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

  // Type check: useDoc returns QueryResult<Doc>
  expectTypeOf<ReturnType<typeof _useDoc>>().toEqualTypeOf<QueryResult<Doc>>();

  // Type check: QueryResult has the expected structure
  expectTypeOf<QueryResult<Doc>>().toEqualTypeOf<
    | {
        status: "loading";
        data: undefined;
        error: undefined;
      }
    | {
        status: "success";
        data: Doc;
        error: undefined;
      }
    | {
        status: "error";
        data: undefined;
        error: Error;
      }
  >();

  // Type narrowing check
  const mockResult = {} as QueryResult<Doc>;
  if (mockResult.status === "success") {
    expectTypeOf<typeof mockResult.data>().toEqualTypeOf<Doc>();
  }

  // Even with createIfMissing, the initial state can be loading
  type UseDocResult = ReturnType<typeof _useDoc>;
  expectTypeOf<UseDocResult>().toMatchTypeOf<{ data: Doc | undefined }>();
});
