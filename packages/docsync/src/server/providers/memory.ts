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
          if (operations.length === 0) {
            // The current clock of a document includes its snapshot, not only
            // its operations: compaction removes operation rows, and a document
            // created without any never had one.
            const allOps = operationsMap.get(docId) ?? [];
            return Math.max(
              docs.get(docId)?.clock ?? 0,
              ...allOps.map((op) => op.clock),
              0,
            );
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
          // A document stored for the first time at clock 0 was created offline
          // and carries no operations to take a clock from. Give it one, or the
          // client never hears a clock above its own and resends it forever.
          const assigned =
            clock === 0 && !docs.has(docId) ? nextClock(docId) : clock;
          docs.set(docId, { serializedDoc, clock: assigned });
          return assigned;
        },
      };

      return callback(ctx);
    },
  };
}
