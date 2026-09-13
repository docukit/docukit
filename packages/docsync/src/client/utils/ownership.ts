import type { DocSyncClient } from "../index.js";
import { handleSync } from "../handlers/clientInitiated/sync/sync.js";
import {
  dispatchLocalDocFound,
  dispatchNetworkDocFound,
  dispatchNetworkDocNotFound,
} from "./dispatchDocQueryAction.js";
import {
  exportHistoryFromCurrentSource,
  replaceDocInCache,
  resolvePendingMemoryOperations,
} from "./liveDoc.js";

/**
 * One tab owns a document at a time. Only the owner writes the document's
 * local store and syncs it with the server; every other tab that has the
 * document loaded is a mirror, kept current by the owner's broadcasts. A tab
 * takes a document over when it edits it, or when it loads a document that
 * is not in the store yet; opening a document another tab already owns
 * leaves that tab in charge.
 *
 * Ownership is a Web Lock named after the user and the document, so it is
 * released by the browser when the owning tab goes away. Handing it over on
 * purpose goes through the broadcast channel: the tab that wants the document
 * asks, the owner persists what it still holds in memory, waits for its sync
 * in flight to finish, and only then gives the lock up.
 */
export type DocOwnership = {
  role: "owner" | "mirror";
  /**
   * Gives the lock up, settling once it is free. Present only while this tab
   * is the owner.
   */
  release?: () => Promise<void>;
  acquiring?: Promise<boolean>;
  releasing?: Promise<void>;
  /** The tab that asked for the document while this one was still taking it. */
  pendingRequest?: string;
  /** Settles this tab's request once the owner acknowledges it. */
  acknowledged?: () => void;
};

/**
 * Handoff messages carry the requesting tab's client id, so an owner answers
 * the right tab.
 */
export type OwnershipMessage =
  | { type: "OWNERSHIP_REQUEST"; docId: string; requestId: string }
  | { type: "OWNERSHIP_RELEASING"; docId: string; requestId: string }
  | { type: "OWNERSHIP_RELEASED"; docId: string }
  | { type: "SYNCED"; docId: string; found: boolean };

/**
 * How long a tab waits for the owner to acknowledge a handoff before treating
 * that tab as gone and taking the lock over. An owner that is alive answers
 * immediately; the time it then needs to persist and release is not bounded.
 */
const OWNERSHIP_ACK_TIMEOUT = 300;

export const createDocOwnership = (): DocOwnership => ({ role: "mirror" });

const lockName = (userId: string, docId: string) =>
  `docsync:${userId}:${docId}`;

const hasWebLocks = () =>
  typeof navigator !== "undefined" && "locks" in navigator;

/** A held lock. `release` settles once the lock is actually free again. */
type HeldLock = { release: () => Promise<void> };

/**
 * Requests a Web Lock and resolves once it is held, or with `undefined` when
 * it could not be granted. `onLost` runs if the lock is later stolen.
 */
function requestLock(
  name: string,
  options: LockOptions,
  onLost: () => void,
): Promise<HeldLock | undefined> {
  return new Promise((resolve) => {
    let granted = false;
    const request = navigator.locks.request(name, options, (lock) => {
      if (!lock) {
        resolve(undefined);
        return;
      }
      granted = true;
      return new Promise<void>((release) => {
        resolve({
          release: () => {
            release();
            return settled;
          },
        });
      });
    });
    const settled: Promise<void> = request.then(
      () => undefined,
      () => undefined,
    );
    void request.catch(() => {
      // Rejected before the callback ran: the request was aborted. Rejected
      // after: another tab stole the lock.
      if (granted) onLost();
      else resolve(undefined);
    });
  });
}

/**
 * Asks the owner for the document and waits for its lock. Requests do not
 * overlap in practice: a tab asks when it is edited, and one keyboard edits
 * one tab at a time. If two tabs ever ask at once, the lock goes to the
 * first and that tab passes the document on (see `pendingRequest`).
 */
async function takeOverLock<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  ownership: DocOwnership,
  name: string,
  onLost: () => void,
): Promise<HeldLock | undefined> {
  const acknowledged = new Promise<{ type: "acknowledged" | "silent" }>(
    (resolve) => {
      ownership.acknowledged = () => resolve({ type: "acknowledged" });
      setTimeout(() => resolve({ type: "silent" }), OWNERSHIP_ACK_TIMEOUT);
    },
  );
  client["_bcHelper"]?.broadcast({
    type: "OWNERSHIP_REQUEST",
    docId,
    requestId: client["_clientId"],
  });
  const controller = new AbortController();
  const pending = requestLock(name, { signal: controller.signal }, onLost).then(
    (held) => ({ type: "lock" as const, held }),
  );
  try {
    const answer = await Promise.race([pending, acknowledged]);
    if (answer.type === "lock") return answer.held;
    if (answer.type === "acknowledged") return (await pending).held;
    // Nobody answered: the owner is gone, or frozen. Its lock is taken.
    controller.abort();
    const granted = (await pending).held;
    if (granted) return granted;
    return requestLock(name, { steal: true }, onLost);
  } finally {
    delete ownership.acknowledged;
  }
}

/**
 * Makes this tab the owner of a loaded document. Resolves `false` only when
 * the document was unloaded meanwhile, or when `ifAvailable` is set and
 * another tab holds it.
 */
export async function acquireOwnership<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  options: { ifAvailable?: boolean } = {},
): Promise<boolean> {
  const entry = client["_docsCache"].get(docId);
  if (!entry) return false;
  const ownership = entry.ownership;
  if (ownership.acquiring) {
    // Join the attempt in flight. If it comes back empty-handed, the lock may
    // have been freed since, so this call makes an attempt of its own.
    if (await ownership.acquiring) return true;
    if (client["_docsCache"].get(docId) !== entry) return false;
  }
  if (ownership.role === "owner") return true;

  const acquiring = (async () => {
    const { identity } = await client["_localPromise"];
    if (client["_docsCache"].get(docId) !== entry) return false;
    if (!hasWebLocks()) {
      // Without Web Locks every tab owns its documents, as before.
      ownership.role = "owner";
      return true;
    }
    const name = lockName(identity.userId, docId);
    const onLost = () => {
      if (ownership.role !== "owner") return;
      ownership.role = "mirror";
      delete ownership.release;
    };
    let held = await requestLock(name, { ifAvailable: true }, onLost);
    if (!held && !options.ifAvailable) {
      held = await takeOverLock(client, docId, ownership, name, onLost);
    }
    if (!held) return false;
    if (client["_docsCache"].get(docId) !== entry) {
      void held.release();
      return false;
    }
    ownership.role = "owner";
    ownership.release = held.release;
    return true;
  })();
  ownership.acquiring = acquiring;
  try {
    return await acquiring;
  } finally {
    delete ownership.acquiring;
  }
}

/**
 * Gives a document up: persists the batch still in memory, lets the sync in
 * flight finish, then releases the lock. `broadcastReleased` tells the other
 * tabs that nobody owns the document now, so one of them can take it.
 */
export function releaseOwnership<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  ownership: DocOwnership,
  options: { broadcastReleased: boolean },
): Promise<void> {
  if (ownership.releasing) return ownership.releasing;
  if (ownership.role !== "owner") return Promise.resolve();

  const releasing = (async () => {
    await client["_flushLocalOperations"](docId, { sync: false });
    // A sync in flight for a document that is still loaded writes the store
    // when its response arrives, so it gets to finish first. One for a
    // document that was unloaded is stale and writes nothing.
    if (client["_docsCache"].get(docId)?.ownership === ownership) {
      await client["_syncQueue"].get(docId)?.done;
    }
    ownership.role = "mirror";
    await ownership.release?.();
    delete ownership.release;
    if (options.broadcastReleased) {
      client["_bcHelper"]?.broadcast({ type: "OWNERSHIP_RELEASED", docId });
    }
    // An edit that landed while the document was being handed over stayed in
    // memory. It is this tab's to persist, so the document is asked back.
    if (client["_localOpsBatchState"].has(docId)) {
      void takeOwnership(client, docId);
    }
  })();
  ownership.releasing = releasing;
  return releasing.finally(() => {
    delete ownership.releasing;
  });
}

/**
 * Releases every owned document at once, for a tab that is going away. The
 * batches in memory are persisted on a best-effort basis: the page may be
 * gone before the writes complete.
 */
export function releaseAllOwnership<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>): void {
  for (const [docId, entry] of client["_docsCache"]) {
    const ownership = entry.ownership;
    if (ownership.role !== "owner") continue;
    void client["_flushLocalOperations"](docId, { sync: false });
    ownership.role = "mirror";
    void ownership.release?.();
    delete ownership.release;
    client["_bcHelper"]?.broadcast({ type: "OWNERSHIP_RELEASED", docId });
  }
}

const serializedEquals = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Brings the live doc of a document this tab just took over in line with the
 * local store. As a mirror, the tab applied the owner's broadcasts and its
 * own edits in the order they happened here, which is not necessarily the
 * order the previous owner persisted. The store is rebuilt with this tab's
 * unpersisted batch on top; when the result differs from the live doc, the
 * live doc is replaced, keeping its undo history.
 */
async function reconcileOwnedDocWithStorage<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, docId: string): Promise<void> {
  const entry = client["_docsCache"].get(docId);
  if (entry?.ownership.role !== "owner") return;
  const liveDoc = await entry.promisedDoc;
  if (!liveDoc) return;
  const isCurrent = () =>
    client["_docsCache"].get(docId) === entry &&
    entry.ownership.role === "owner" &&
    entry.promisedDoc !== undefined;
  if (!isCurrent()) return;

  const docBinding = client["_docBinding"];
  const { provider } = await client["_localPromise"];
  const rebuilt = await provider.transaction("readonly", async (ctx) => {
    const stored = await ctx.getSerializedDoc({ docId });
    if (!stored) return undefined;
    const batches = await ctx.getOperations({ docId });
    const doc = docBinding.deserialize(stored.serializedDoc);
    for (const batch of batches) {
      for (const operations of batch) {
        docBinding.applyOperations(doc, operations, { skipUndo: true });
      }
    }
    return doc;
  });
  if (!rebuilt) return;
  if (!isCurrent()) {
    docBinding.dispose(rebuilt);
    return;
  }

  // Synchronous from here: exporting the history force-commits a pending
  // edit into the batch, which the rebuilt doc then receives before any other
  // user event can run.
  const historySource = { doc: liveDoc, promisedDoc: entry.promisedDoc };
  const batchBeforeExport = client["_localOpsBatchState"].get(docId)?.data;
  const exportedHistory = exportHistoryFromCurrentSource(
    client,
    docId,
    historySource,
  );
  for (const operations of resolvePendingMemoryOperations(
    client,
    docId,
    batchBeforeExport,
  )) {
    docBinding.applyOperations(rebuilt, operations, { skipUndo: true });
  }
  if (
    serializedEquals(
      docBinding.serialize(rebuilt),
      docBinding.serialize(liveDoc),
    )
  ) {
    docBinding.dispose(rebuilt);
    return;
  }
  const replaceResult = replaceDocInCache(client, {
    docId,
    doc: rebuilt,
    ...(exportedHistory && { exportedHistory }),
  });
  dispatchLocalDocFound(client, docId, { doc: rebuilt, docId });
  if (replaceResult) throw replaceResult.historyImportError;
}

/**
 * Takes a loaded document over from whichever tab owns it, then persists and
 * syncs what this tab holds in memory for it.
 */
export async function takeOwnership<
  D extends object,
  S extends object,
  O extends object,
>(
  client: DocSyncClient<D, S, O>,
  docId: string,
  options: { ifAvailable?: boolean } = {},
): Promise<void> {
  if (!(await acquireOwnership(client, docId, options))) return;
  await reconcileOwnedDocWithStorage(client, docId);
  const entry = client["_docsCache"].get(docId);
  if (entry?.ownership.role !== "owner") return;
  await client["_flushLocalOperations"](docId, { sync: false });
  if (entry.ownership.pendingRequest !== undefined) {
    delete entry.ownership.pendingRequest;
    await releaseOwnership(client, docId, entry.ownership, {
      broadcastReleased: false,
    });
    return;
  }
  void handleSync(client, docId);
}

export function handleOwnershipMessage<
  D extends object,
  S extends object,
  O extends object,
>(client: DocSyncClient<D, S, O>, message: OwnershipMessage): void {
  const entry = client["_docsCache"].get(message.docId);
  if (!entry) return;
  const ownership = entry.ownership;
  const { docId } = message;

  switch (message.type) {
    case "OWNERSHIP_REQUEST": {
      const answer = () =>
        client["_bcHelper"]?.broadcast({
          type: "OWNERSHIP_RELEASING",
          docId,
          requestId: message.requestId,
        });
      if (ownership.role === "owner") {
        answer();
        void releaseOwnership(client, docId, ownership, {
          broadcastReleased: false,
        });
      } else if (ownership.acquiring) {
        // This tab is in line for the lock. It answers now and passes the
        // document on as soon as it has it.
        answer();
        ownership.pendingRequest = message.requestId;
      }
      return;
    }
    case "OWNERSHIP_RELEASING": {
      if (message.requestId === client["_clientId"]) ownership.acknowledged?.();
      return;
    }
    case "OWNERSHIP_RELEASED": {
      if (ownership.role === "mirror") {
        void takeOwnership(client, docId, { ifAvailable: true });
      }
      return;
    }
    case "SYNCED": {
      // A mirror cannot reach the server for this document; the owner's
      // syncs are what settle its query.
      if (ownership.role !== "mirror") return;
      const data = entry.queryResult.data;
      if (message.found && data) {
        dispatchNetworkDocFound(client, docId, data);
      } else if (!message.found && !data) {
        dispatchNetworkDocNotFound(client, docId, { createIfMissing: false });
      }
      return;
    }
  }
}
