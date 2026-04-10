/* eslint-disable @typescript-eslint/no-empty-object-type */
import type { ServerProvider, ServerProviderContext } from "../types.js";

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
export function inMemoryServerProvider<
  S extends {} = {},
  O extends {} = {},
>(): ServerProvider<S, O> {
  const docs = new Map<string, StoredDoc<S>>();
  const operationsMap = new Map<string, StoredOperation<O>[]>();
  const clockCounterByDocId = new Map<string, number>();

  function nextClock(docId: string): number {
    const current = clockCounterByDocId.get(docId) ?? 0;
    const next = current + 1;
    clockCounterByDocId.set(docId, next);
    return next;
  }

  return {
    async transaction<T>(
      _mode: "readonly" | "readwrite",
      callback: (ctx: ServerProviderContext<S, O>) => Promise<T>,
    ): Promise<T> {
      const ctx: ServerProviderContext<S, O> = {
        // eslint-disable-next-line @typescript-eslint/require-await -- sync implementation of async interface
        getSerializedDoc: async (docId: string) => {
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
          if (operations.length === 0) {
            const allOps = operationsMap.get(docId) ?? [];
            return allOps.length > 0
              ? Math.max(...allOps.map((op) => op.clock))
              : 0;
          }

          const newClock = nextClock(docId);
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
