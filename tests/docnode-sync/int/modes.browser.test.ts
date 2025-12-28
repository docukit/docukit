import { DocSyncClient, IndexedDBProvider } from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";
import { test } from "vitest";

test.todo("localFirst", async () => {
  const _localFirst = new DocSyncClient({
    server: {
      url: "ws://localhost:8081",
      auth: {
        getToken: async () => "1234567890" as string,
      },
    },
    docBinding: DocNodeBinding([]),
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({
        userId: "John",
        secret: "asdasdasd",
      }),
    },
  });
  // get doc first retrieves from local storage, and then from the server

  // omits server
  const _localOnly = new DocSyncClient({
    docBinding: DocNodeBinding([]),
    local: {
      provider: IndexedDBProvider,
      getIdentity: async () => ({
        userId: "John",
        secret: "asdasdasd",
      }),
    },
  });
  // It's as if there's no internet. It simply does not connect to the ws server.
  // Operations pile up in the operations store, but they never squash in the doc store.

  // does not have local key
  const _serverOnly = new DocSyncClient({
    server: {
      url: "ws://localhost:8081",
      auth: {
        getToken: async () => "1234567890" as string,
      },
    },
    docBinding: DocNodeBinding([]),
  });
});
