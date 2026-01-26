import { DocNodeBinding } from "@docnode/docsync-react/docnode";
import { DocSyncServer, PostgresProvider } from "@docnode/docsync-react/server";
import { indexDocConfig } from "./shared-config.ts";
import { lexicalDocNodeConfig } from "@docnode/lexical";

new DocSyncServer({
  docBinding: DocNodeBinding([indexDocConfig, lexicalDocNodeConfig]),
  port: 8081,
  provider: PostgresProvider,
  authenticate: async ({ token }) => ({ userId: token }), // Use token as userId
});
