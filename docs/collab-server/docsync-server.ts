import { DocNodeBinding } from "@docukit/docsync-react/docnode";
import { DocSyncServer } from "@docukit/docsync-react/server";
import { createLexicalDocNodeConfig } from "@docukit/docnode-lexical";
import { indexDocConfig } from "../src/components/examples/shared-config.ts";
import { sqliteProvider } from "./sqlite-provider.ts";

const port = Number(process.env.PORT ?? process.env.DOCSYNC_PORT ?? "8081");
if (!Number.isInteger(port) || port <= 0) {
  throw new Error("PORT/DOCSYNC_PORT must be a positive integer");
}

const server = new DocSyncServer({
  docBinding: DocNodeBinding([
    indexDocConfig,
    createLexicalDocNodeConfig({ undoManager: { maxUndoSteps: 100 } }),
  ]),
  port,
  provider: sqliteProvider({
    ttlMs: Number(process.env.DOCSYNC_DOC_TTL_MS ?? 7 * 24 * 60 * 60 * 1000),
    cleanupIntervalMs: Number(
      process.env.DOCSYNC_CLEANUP_INTERVAL_MS ?? 60_000,
    ),
  }),
  authenticate: ({ token }) => ({ userId: token }), // Use token as userId
});

server.onDocSubscribe(({ docId, userId, deviceId, clientId, socketId }) => {
  console.log(
    `[docsync] doc connect docId=${docId} userId=${userId} deviceId=${deviceId} clientId=${clientId} socketId=${socketId}`,
  );
});

server.onDocUnsubscribe(
  ({ docId, userId, deviceId, clientId, socketId, reason }) => {
    console.log(
      `[docsync] doc disconnect docId=${docId} userId=${userId} deviceId=${deviceId} clientId=${clientId} socketId=${socketId} reason=${reason}`,
    );
  },
);
