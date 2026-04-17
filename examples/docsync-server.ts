import { DocNodeBinding } from "@docukit/docsync-react/docnode";
import { DocSyncServer } from "@docukit/docsync-react/server";
import { indexDocConfig } from "./shared-config.ts";
import { lexicalDocNodeConfig } from "@docukit/docnode-lexical";
import { postgresProvider } from "./postgres-provider.ts";

new DocSyncServer({
  docBinding: DocNodeBinding([indexDocConfig, lexicalDocNodeConfig]),
  port: 8081,
  provider: postgresProvider({
    url: "postgres://docukit:docukit@localhost:5433/docukit",
  }),
  authenticate: ({ token }) => ({ userId: token }), // Use token as userId
});
