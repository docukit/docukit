import { DocNodeValidators } from "@docukit/docsync2/docnode";
import { DocSyncServer } from "@docukit/docsync2/server";
import { sqliteProvider } from "./sqlite-provider.ts";

const port = Number(process.env.PORT ?? process.env.DOCSYNC_PORT ?? "8081");
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("PORT/DOCSYNC_PORT must be a positive integer");
}

new DocSyncServer({
  validators: DocNodeValidators(),
  port,
  provider: sqliteProvider({
    ttlMs: Number(process.env.DOCSYNC_DOC_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
    cleanupIntervalMs: Number(
      process.env.DOCSYNC_CLEANUP_INTERVAL_MS ?? 60_000,
    ),
  }),
  authenticate: ({ token }) => ({ userId: token }), // Use token as userId
});
