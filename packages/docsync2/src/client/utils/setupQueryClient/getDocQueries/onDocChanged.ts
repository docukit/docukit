import type { DocSyncClient } from "../../../index.js";
import type { GetDocArgs } from "../../../queries/getDoc/getDoc.js";
import { flushLocalOperations } from "../../flushLocalOperations.js";
import { getOwnPresencePatch } from "../../getOwnPresencePatch.js";

const queueLocalOperations = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: { docId: string; operations: O[] },
) => {
  const now = Date.now();
  const state = client["_localOpsBatchState"].get(args.docId) ?? {
    data: [],
    startedAt: now,
  };

  state.data.push(...args.operations);
  client["_localOpsBatchState"].set(args.docId, state);

  const maxDebounce = client["_collabDocIds"].has(args.docId)
    ? client["_collabMaxDebounce"]
    : client["_singleClientMaxDebounce"];
  const elapsed = now - state.startedAt;
  if (maxDebounce === 0 || elapsed >= maxDebounce) {
    void flushLocalOperations(client, args.docId);
    return;
  }

  if (state.timeout !== undefined) return;

  state.timeout = setTimeout(() => {
    void flushLocalOperations(client, args.docId);
  }, maxDebounce - elapsed);
};

const scheduleBroadcast = (broadcast: () => void) => {
  if (typeof requestAnimationFrame === "undefined") {
    setTimeout(broadcast, 0);
    return;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(broadcast);
  });
};

export const onDocChanged = <
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  args: GetDocArgs,
  { flags, operations }: { flags?: { skipUndo?: boolean }; operations: O },
) => {
  const origin = client["_changeOrigin"];
  client["_events"].emit("change", {
    docId: args.id,
    origin,
    operation: operations,
  });

  if (origin !== "local") return;

  queueLocalOperations(client, { docId: args.id, operations: [operations] });
  scheduleBroadcast(() => {
    const presencePatch = getOwnPresencePatch(client, args.id);
    client["_bcHelper"]?.broadcast({
      type: "OPERATIONS",
      source: "local-broadcast",
      operations,
      docId: args.id,
      ...(flags?.skipUndo ? { flags: { skipUndo: true } } : {}),
      ...(presencePatch ? { presence: presencePatch } : {}),
    });
  });
};
