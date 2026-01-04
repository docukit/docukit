import type { ServerProvider } from "../types.js";
import type { DocSyncEvents } from "../../shared/types.js";

interface StoredDoc<S> {
  serializedDoc: S;
  clock: number;
}

interface StoredOperation<O> {
  operations: O;
  clock: number;
}

/**
 * In-memory server provider for testing.
 * Stores documents and operations in memory - data is lost when the process ends.
 */
export class InMemoryServerProvider<S, O> implements ServerProvider<S, O> {
  private _docs = new Map<string, StoredDoc<S>>();
  private _operations = new Map<string, StoredOperation<O>[]>();
  private _clockCounterByDocId = new Map<string, number>();

  private _nextClock(docId: string): number {
    const current = this._clockCounterByDocId.get(docId) ?? 0;
    const next = current + 1;
    this._clockCounterByDocId.set(docId, next);
    return next;
  }

  async sync(
    req: DocSyncEvents<S, O>["sync-operations"]["request"],
  ): Promise<DocSyncEvents<S, O>["sync-operations"]["response"]> {
    const { docId, operations: clientOps, clock: clientClock } = req;

    // 1. Get operations the client doesn't have (clock > clientClock)
    const allOps = this._operations.get(docId) ?? [];
    const serverOps = allOps
      .filter((op) => op.clock > clientClock)
      .map((op) => op.operations);

    // 2. Get server document only if its clock > client clock
    const storedDoc = this._docs.get(docId);
    const serverDoc =
      storedDoc && storedDoc.clock > clientClock
        ? storedDoc.serializedDoc
        : null;

    // 3. Save client operations if provided
    const newClock =
      clientOps && clientOps.length > 0 ? this._nextClock(docId) : clientClock;
    if (clientOps && clientOps.length > 0) {
      for (const op of clientOps) {
        const docOps = this._operations.get(docId) ?? [];
        docOps.push({ operations: op, clock: newClock });
        this._operations.set(docId, docOps);
      }
    }

    // 4. Return data
    return {
      docId,
      operations: serverOps.length > 0 ? serverOps : null,
      serializedDoc: serverDoc as S,
      clock: newClock,
    };
  }

  /** For testing: clear all data */
  clear(): void {
    this._docs.clear();
    this._operations.clear();
    this._clockCounterByDocId.clear();
  }

  /** For testing: get stored operations count */
  getOperationsCount(docId: string): number {
    return this._operations.get(docId)?.length ?? 0;
  }
}
