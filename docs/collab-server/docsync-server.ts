import { DocNodeBinding } from "@docukit/docsync-react/docnode";
import { DocSyncServer } from "@docukit/docsync-react/server";
import { lexicalDocNodeConfig } from "@docukit/docnode-lexical";
import { indexDocConfig } from "../src/components/examples/shared-config.ts";
import { sqliteProvider } from "./sqlite-provider.ts";

const port = Number(process.env.DOCSYNC_PORT ?? "8081");
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("DOCSYNC_PORT must be a positive integer");
}

new DocSyncServer({
  docBinding: DocNodeBinding([indexDocConfig, lexicalDocNodeConfig]),
  port,
  provider: sqliteProvider({
    ttlMs: Number(process.env.DOCSYNC_DOC_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
    cleanupIntervalMs: Number(
      process.env.DOCSYNC_CLEANUP_INTERVAL_MS ?? 60_000,
    ),
  }),
  authenticate: ({ token }) => ({ userId: token }), // Use token as userId
});
