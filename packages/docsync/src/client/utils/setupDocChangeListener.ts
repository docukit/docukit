import type { DocSyncClient } from "../index.js";
import { flushPresenceDebounce } from "../handlers/clientInitiated/presence.js";
import { getOwnPresencePatch } from "./getOwnPresencePatch.js";

export function setupDocChangeListener<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, args: { doc: D; docId: string }): void {
  const { doc, docId } = args;

  client["_docBinding"].onChange(doc, ({ flags, operations }) => {
    const changeOrigin = client["_changeOrigin"];

    client["_events"].emit("change", {
      docId,
      origin: changeOrigin,
      operation: operations,
    });

    if (changeOrigin !== "local") {
      const timeoutBeforeChange =
        client["_presenceDebounceState"].get(docId)?.timeout;
      queueMicrotask(() =>
        flushPresenceDebounce(client, docId, { timeoutBeforeChange }),
      );
      return;
    }

    void client.onLocalOperations({ docId, operations: [operations] });

    // Defer BC send so Lexical can update selection first; then the presence we
    // include is the new cursor. Two frames so setPresence (from selection change) has run.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        client["_bcHelper"]?.broadcast({
          type: "OPERATIONS",
          source: "local-broadcast",
          operations,
          docId,
          flags: flags?.skipUndo ? { skipUndo: true } : {},
          presence: getOwnPresencePatch(client, docId),
        });
      });
    });
  });
}
