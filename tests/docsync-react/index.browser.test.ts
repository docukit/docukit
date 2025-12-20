import { test, expectTypeOf } from "vitest";
import {
  createDocSyncClient,
  IndexedDBProvider,
} from "@docnode/docsync-react/client";
import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import type { Doc } from "docnode";

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

  expectTypeOf<ReturnType<typeof _useDoc>>().toEqualTypeOf<
    { doc: Doc; id: string } | { doc: undefined; id: undefined }
  >();
});
