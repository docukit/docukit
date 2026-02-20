import type { DocSyncClient } from "../../index.js";
import { getOwnPresencePatch } from "../../utils/getOwnPresencePatch.js";

export function setupChangeListener<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
>(client: DocSyncClient<D, S, O>, doc: D, docId: string): void {
  client["_docBinding"].onChange(doc, ({ operations }) => {
    if (client["_shouldBroadcast"]) {
      void client.onLocalOperations({ docId, operations: [operations] });

      client["_events"].emit("change", {
        docId,
        origin: "local",
        operations: [operations],
      });

      // Defer BC send so Lexical can update selection first; then the presence we
      // include is the new cursor. Two frames so setPresence (from selection change) has run.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const presencePatch = getOwnPresencePatch(client, docId);
          client["_bcHelper"]?.broadcast({
            type: "OPERATIONS",
            operations,
            docId,
            ...(presencePatch && { presence: presencePatch }),
          });
        });
      });
    }
    // Don't automatically reset _shouldBroadcast here!
    // Let the caller explicitly control when to re-enable broadcasting
  });
}
