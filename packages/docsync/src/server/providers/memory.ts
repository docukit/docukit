/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ServerProvider, ServerProviderContext } from "../types.js";

interface StoredDoc {
  serializedDoc: unknown;
  clock: number;
}

interface StoredOperation {
  operations: unknown;
  clock: number;
}

/**
 * In-memory server provider for testing.
 * Stores documents and operations in memory - data is lost when the process ends.
 */
export function inMemoryServerProvider(): ServerProvider<any, any> {
  const docs = new Map<string, StoredDoc>();
  const operationsMap = new Map<string, StoredOperation[]>();

  /**
   * The clock of a document covers its snapshot as well as its operations:
   * compaction removes operation rows, a document created without any never had
   * one, and the sync handler gives a newly stored document a clock of its own.
   * Deriving the clock from what is stored, rather than from a counter kept
   * beside it, is also what the documented SQLite provider does.
   */
  function currentClock(docId: string): number {
    const allOps = operationsMap.get(docId) ?? [];
    return Math.max(
      docs.get(docId)?.clock ?? 0,
      ...allOps.map((op) => op.clock),
      0,
    );
  }

  return {
    async transaction<T>(
      _mode: "readonly" | "readwrite",
      callback: (ctx: ServerProviderContext<any, any>) => Promise<T>,
    ): Promise<T> {
      const ctx: ServerProviderContext<any, any> = {
        // eslint-disable-next-line @typescript-eslint/require-await -- sync implementation of async interface
        getSerializedDoc: async ({ docId }) => {
          return docs.get(docId);
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- sync implementation of async interface
        getOperations: async ({ docId, clock }) => {
          const allOps = operationsMap.get(docId) ?? [];
          const serverOps = allOps
            .filter((op) => op.clock > clock)
            .map((op) => [op.operations]);
          return serverOps;
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- sync implementation of async interface
        deleteOperations: async ({ docId, count }) => {
          const allOps = operationsMap.get(docId) ?? [];
          allOps.splice(0, count);
          if (allOps.length === 0) {
            operationsMap.delete(docId);
          } else {
            operationsMap.set(docId, allOps);
          }
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- sync implementation of async interface
        saveOperations: async ({ docId, operations }) => {
          if (operations.length === 0) return currentClock(docId);

          const newClock = currentClock(docId) + 1;
          const docOps = operationsMap.get(docId) ?? [];
          for (const op of operations) {
            docOps.push({ operations: op, clock: newClock });
          }
          operationsMap.set(docId, docOps);
          return newClock;
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- sync implementation of async interface
        saveSerializedDoc: async ({ docId, serializedDoc, clock }) => {
          docs.set(docId, { serializedDoc, clock });
        },
      };

      return callback(ctx);
    },
  };
}
