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
 * `readwrite` transactions on the same document run one at a time.
 */
export function inMemoryServerProvider(): ServerProvider<any, any> {
  const docs = new Map<string, StoredDoc>();
  const operationsMap = new Map<string, StoredOperation[]>();
  const clockCounterByDocId = new Map<string, number>();
  const queueByDocId = new Map<string, Promise<void>>();

  function nextClock(docId: string): number {
    // A snapshot can arrive with a clock this counter never reached, e.g. a
    // client restoring a doc the server lost. New batches must go after it.
    const current = Math.max(
      clockCounterByDocId.get(docId) ?? 0,
      docs.get(docId)?.clock ?? 0,
    );
    const next = current + 1;
    clockCounterByDocId.set(docId, next);
    return next;
  }

  return {
    transaction<T>(
      { mode, docId }: { mode: "readonly" | "readwrite"; docId: string },
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
            const allOps = operationsMap.get(docId) ?? [];
            // A trimmed log must not rewind the clock of the document.
            return Math.max(
              docs.get(docId)?.clock ?? 0,
              ...allOps.map((op) => op.clock),
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
          docs.set(docId, { serializedDoc, clock });
        },
      };

      if (mode === "readonly") return callback(ctx);

      const previous = queueByDocId.get(docId) ?? Promise.resolve();
      const result = previous.then(() => callback(ctx));
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      queueByDocId.set(docId, settled);
      void settled.then(() => {
        if (queueByDocId.get(docId) === settled) queueByDocId.delete(docId);
      });
      return result;
    },
  };
}
