import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import { DocSyncServer, PostgresProvider } from "@docnode/docsync-react/server";

new DocSyncServer({
  docBinding: DocNodeBinding([]),
  port: 8081,
  provider: PostgresProvider,
  authenticate: async () => ({ userId: "John" }),
});
