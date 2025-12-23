import { DocSyncClient, IndexedDBProvider } from "@docnode/docsync/client";
import { DocNodeBinding } from "@docnode/docsync/docnode";

const _localFirst = new DocSyncClient({
  url: "ws://localhost:8081",
  docBinding: DocNodeBinding([]),
  local: {
    provider: IndexedDBProvider,
    getIdentity: async () => ({
      userId: "John",
      secret: "asdasdasd",
    }),
  },
  auth: {
    getToken: async () => "1234567890" as string,
  },
});
// get doc first retrieves from local storage, and then from the server

const _localOnly = new DocSyncClient({
  url: "ws://localhost:8081",
  docBinding: DocNodeBinding([]),
  local: {
    provider: IndexedDBProvider,
    getIdentity: async () => ({
      userId: "John",
      secret: "asdasdasd",
    }),
  },
  // @ts-expect-error - not implemented yet
  connect: false,
  auth: {
    getToken: async () => "1234567890" as string,
  },
});
// It's as if there's no internet. It simply does not connect to the ws server.
// Operations pile up in the operations store, but they never squash in the doc store.

const _serverOnly = new DocSyncClient({
  url: "ws://localhost:8081",
  docBinding: DocNodeBinding([]),
  auth: {
    getToken: async () => "1234567890" as string,
  },
});
