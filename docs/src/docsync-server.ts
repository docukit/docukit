import { DocSyncServer, PostgresProvider } from "@docnode/docsync-react/server";

new DocSyncServer({
  port: 8081,
  provider: PostgresProvider,
  authenticate: async () => ({ userId: "John Salchichon" }),
});
