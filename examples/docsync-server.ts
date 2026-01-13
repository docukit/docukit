import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import { DocSyncServer, PostgresProvider } from "@docnode/docsync-react/server";
import { IndexDocConfig } from "./shared-config.ts";

new DocSyncServer({
  docBinding: DocNodeBinding([IndexDocConfig]),
  port: 8081,
  provider: PostgresProvider,
  authenticate: async () => ({ userId: "John" }),
});
