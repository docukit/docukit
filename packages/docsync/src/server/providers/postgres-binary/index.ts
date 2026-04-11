import { queryClient } from "./schema.js";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { eq, gt, and, asc } from "drizzle-orm";
import type { ServerProvider, ServerProviderContext } from "../../types.js";

export class PostgresBinaryProvider implements ServerProvider<
  Uint8Array,
  Uint8Array
> {
  private _db = drizzle(queryClient, { schema });

  async transaction<T>(
    _mode: "readonly" | "readwrite",
    callback: (
      ctx: ServerProviderContext<Uint8Array, Uint8Array>,
    ) => Promise<T>,
  ): Promise<T> {
    return await this._db.transaction(async (tx) => {
      const ctx: ServerProviderContext<Uint8Array, Uint8Array> = {
        getSerializedDoc: async (docId: string) => {
          const doc = await tx.query.binaryDocuments.findFirst({
            where: eq(schema.binaryDocuments.docId, docId),
          });
          return doc
            ? { serializedDoc: doc.doc, clock: doc.clock.getTime() }
            : undefined;
        },

        getOperations: async ({ docId, clock }) => {
          const clockDate = new Date(clock);
          const serverOps = await tx
            .select({ operations: schema.binaryOperations.operations })
            .from(schema.binaryOperations)
            .where(
              and(
                eq(schema.binaryOperations.docId, docId),
                gt(schema.binaryOperations.clock, clockDate),
              ),
            )
            .orderBy(asc(schema.binaryOperations.clock));

          // Each row is one operation; return each as a single-element batch
          return serverOps.map((r) => [r.operations]);
        },

        deleteOperations: async ({ docId, count }) => {
          const toDelete = await tx
            .select({ id: schema.binaryOperations.id })
            .from(schema.binaryOperations)
            .where(eq(schema.binaryOperations.docId, docId))
            .orderBy(asc(schema.binaryOperations.clock))
            .limit(count);

          for (const op of toDelete) {
            await tx
              .delete(schema.binaryOperations)
              .where(eq(schema.binaryOperations.id, op.id));
          }
        },

        saveOperations: async ({ docId, operations }) => {
          if (operations.length === 0) {
            const latestOp = await tx.query.binaryOperations.findFirst({
              where: eq(schema.binaryOperations.docId, docId),
              orderBy: (ops, { desc }) => [desc(ops.clock)],
            });
            return latestOp?.clock.getTime() ?? 0;
          }

          // Insert each operation as its own row (bytea stores one binary value)
          let lastClock = 0;
          for (const op of operations) {
            const inserted = await tx
              .insert(schema.binaryOperations)
              .values({ docId, operations: op })
              .returning({ clock: schema.binaryOperations.clock });
            lastClock = inserted[0]!.clock.getTime();
          }

          return lastClock;
        },

        // eslint-disable-next-line @typescript-eslint/require-await -- not implemented yet
        saveSerializedDoc: async (_arg) => {
          throw new Error(
            "saveSerializedDoc not implemented for PostgresBinaryProvider yet - requires userId context",
          );
        },
      };

      return callback(ctx);
    });
  }
}
