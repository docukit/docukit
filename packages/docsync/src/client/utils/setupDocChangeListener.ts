import type { DocSyncCore } from "../core.js";
import { flushPresenceDebounce } from "../handlers/clientInitiated/presence.js";
import { getOwnPresencePatch } from "./getOwnPresencePatch.js";
import { markLocalDocChanged } from "./localDocVersion.js";

const afterSelectionUpdate = (callback: () => void) => {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => requestAnimationFrame(callback));
  } else {
    // Workers without animation frames have no editor selection to wait for.
    queueMicrotask(callback);
  }
};

export function setupDocChangeListener<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncCore<D, S, O>, args: { doc: D; docId: string }): void {
  const { doc, docId } = args;

  client["_docBinding"].onChange(doc, ({ flags, operations }) => {
    const changeOrigin = client["_changeOrigin"];

    client["_events"].emit("change", {
      docId,
      origin: changeOrigin,
      operation: operations,
    });

    if (changeOrigin !== "network") {
      markLocalDocChanged(client, docId);
    }

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
    afterSelectionUpdate(() => {
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
}
