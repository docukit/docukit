import type { DocSyncClient } from "../../index.js";
import type { DocData, GetDocArgs, QueryResult } from "../../types.js";
import { handleSync } from "../../handlers/clientInitiated/sync/sync.js";
import { setupChangeListener } from "./setupChangeListener.js";

export function getDocMethod<
  D extends {} = {},
  S extends {} = {},
  O extends {} = {},
  T extends GetDocArgs = GetDocArgs,
>(
  client: DocSyncClient<D, S, O>,
  args: T,
  onChange: (
    result: QueryResult<
      T extends { createIfMissing: true } ? DocData<D> : DocData<D> | undefined
    >,
  ) => void,
): () => void {
  const type = args.type;
  const argId = "id" in args ? args.id : undefined;
  const createIfMissing = "createIfMissing" in args && args.createIfMissing;
  // Internal emit uses wider type (doc may be "deleted"); runtime logic ensures correct data per overload
  const emit = onChange as (
    result: QueryResult<DocData<D | "deleted"> | undefined>,
  ) => void;
  let docId: string | undefined;

  // Case: { type, createIfMissing: true } → Create new doc with auto-generated ID (sync).
  if (!argId && createIfMissing) {
    const { doc, docId: createdDocId } = client["_docBinding"].create(type);
    docId = createdDocId;
    client["_docsCache"].set(createdDocId, {
      promisedDoc: Promise.resolve(doc),
      refCount: 1,
      presence: {},
      presenceListeners: new Set(),
      pushStatus: "idle",
      localOpsBatchState: undefined,
      presenceDebounceState: undefined,
    });
    setupChangeListener(client, doc, createdDocId);
    emit({ status: "success", data: { doc, docId: createdDocId } });

    client["_events"].emit("docLoad", {
      docId: createdDocId,
      source: "created",
      refCount: 1,
    });

    void (async () => {
      const local = await client["_localPromise"];
      if (!local) return;
      await local.provider.transaction("readwrite", (ctx) =>
        ctx.saveSerializedDoc({
          serializedDoc: client["_docBinding"].serialize(doc),
          docId: createdDocId,
          clock: 0,
        }),
      );
    })();
    // We don't trigger an initial sync here because argId is undefined;
    // so this is truly a new doc. Initial operations will be pushed to server
    return () => void client["_unloadDoc"](createdDocId);
  }

  // Preparing for the async cases
  emit({ status: "loading" });

  // Case: { type, id } or { type, id, createIfMissing } → Load or create (async).
  if (argId) {
    docId = argId;
    // Check cache BEFORE async block to avoid race conditions with getPresence
    const existingCacheEntry = client["_docsCache"].get(docId);
    if (existingCacheEntry) {
      existingCacheEntry.refCount += 1;
    } else {
      // Create cache entry immediately so getPresence can subscribe
      const promisedDoc = client["_loadOrCreateDoc"](
        docId,
        createIfMissing ? type : undefined,
      );
      client["_docsCache"].set(docId, {
        promisedDoc,
        refCount: 1,
        presence: {},
        presenceListeners: new Set(),
        pushStatus: "idle",
        localOpsBatchState: undefined,
        presenceDebounceState: undefined,
      });
    }

    void (async () => {
      try {
        let doc: D | "deleted" | undefined;
        let source: "cache" | "local" | "created" = "local";
        const cacheEntry = client["_docsCache"].get(docId)!;
        if (existingCacheEntry) {
          doc = await cacheEntry.promisedDoc;
          source = "cache";
        } else {
          doc = await cacheEntry.promisedDoc;
          if (doc && doc !== "deleted") {
            // Register listener only for new docs (not cache hits)
            setupChangeListener(client, doc, docId);
            source = createIfMissing ? "created" : "local";
          }
        }

        if (doc) {
          const refCount = client["_docsCache"].get(docId)?.refCount ?? 1;
          client["_events"].emit("docLoad", { docId, source, refCount });
        }

        emit({ status: "success", data: doc ? { doc, docId } : undefined });
        // Fetch from server to check if document exists there
        if (doc) {
          void handleSync(client, docId);
        }
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        emit({ status: "error", error });
      }
    })();
  }

  return () => {
    if (docId) void client["_unloadDoc"](docId);
  };
}
