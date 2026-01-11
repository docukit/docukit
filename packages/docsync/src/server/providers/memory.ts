import type { ClientProvider, TransactionContext } from "../../client/types.js";

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
export class InMemoryServerProvider<S, O>
  implements ClientProvider<S, O, "server">
{
  private _docs = new Map<string, StoredDoc<S>>();
  private _operations = new Map<string, StoredOperation<O>[]>();
  private _clockCounterByDocId = new Map<string, number>();

  private _nextClock(docId: string): number {
    const current = this._clockCounterByDocId.get(docId) ?? 0;
    const next = current + 1;
    this._clockCounterByDocId.set(docId, next);
    return next;
  }

  async transaction<T>(
    _mode: "readonly" | "readwrite",
    callback: (ctx: TransactionContext<S, O, "server">) => Promise<T>,
  ): Promise<T> {
    // In-memory provider doesn't need real transactions since operations are synchronous
    const ctx: TransactionContext<S, O, "server"> = {
      getSerializedDoc: async (docId: string) => {
        return this._docs.get(docId);
      },

      getOperations: async ({ docId, clock }) => {
        const allOps = this._operations.get(docId) ?? [];
        const serverOps = allOps
          .filter((op) => op.clock > clock)
          .map((op) => [op.operations]);
        return serverOps;
      },

      deleteOperations: async ({ docId, count }) => {
        const allOps = this._operations.get(docId) ?? [];
        allOps.splice(0, count);
        if (allOps.length === 0) {
          this._operations.delete(docId);
        } else {
          this._operations.set(docId, allOps);
        }
      },

      saveOperations: async ({ docId, operations }) => {
        if (operations.length === 0) {
          // Return current clock if no operations to save
          const allOps = this._operations.get(docId) ?? [];
          return allOps.length > 0
            ? Math.max(...allOps.map((op) => op.clock))
            : 0;
        }

        // Increment clock and save operations
        const newClock = this._nextClock(docId);
        const docOps = this._operations.get(docId) ?? [];
        for (const op of operations) {
          docOps.push({ operations: op, clock: newClock });
        }
        this._operations.set(docId, docOps);
        return newClock;
      },

      saveSerializedDoc: async ({ docId, serializedDoc, clock }) => {
        this._docs.set(docId, { serializedDoc, clock });
      },
    };

    return callback(ctx);
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
