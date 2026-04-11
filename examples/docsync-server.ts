import { DocNodeBinding } from "@docukit/docsync-react/docnode";
import { YjsBinding } from "@docukit/docsync-react/yjs";
import {
  DocSyncServer,
  PostgresProvider,
  PostgresBinaryProvider,
} from "@docukit/docsync-react/server";
import { indexDocConfig } from "./shared-config.ts";
import { lexicalDocNodeConfig } from "@docukit/docnode-lexical";

// DocNode server (port 8081)
new DocSyncServer({
  docBinding: DocNodeBinding([indexDocConfig, lexicalDocNodeConfig]),
  port: 8081,
  provider: PostgresProvider,
  authenticate: ({ token }: { token: string }) => ({ userId: token }),
});

// Yjs server (port 8082)
new DocSyncServer({
  docBinding: YjsBinding(),
  port: 8082,
  provider: PostgresBinaryProvider,
  authenticate: ({ token }: { token: string }) => ({ userId: token }),
});
