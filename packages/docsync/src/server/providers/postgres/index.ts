import { queryClient } from "./schema.js";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import { eq, gt, and } from "drizzle-orm";
import type { ServerProvider, ServerProviderContext } from "../../types.js";

export class PostgresProvider<S, O> implements ServerProvider<S, O> {
  private _db = drizzle(queryClient, { schema });

  async transaction<T>(
    _mode: "readonly" | "readwrite",
    callback: (ctx: ServerProviderContext<S, O>) => Promise<T>,
  ): Promise<T> {
    return await this._db.transaction(async (tx) => {
      const ctx: ServerProviderContext<S, O> = {
        getSerializedDoc: async (docId: string) => {
          const doc = await tx.query.documents.findFirst({
            where: eq(schema.documents.docId, docId),
          });
          return doc
            ? { serializedDoc: doc.doc as S, clock: doc.clock.getTime() }
            : undefined;
        },

        getOperations: async ({ docId, clock }) => {
          const clockDate = new Date(clock);
          const serverOps = await tx
            .select({ operations: schema.operations.operations })
            .from(schema.operations)
            .where(
              and(
                eq(schema.operations.docId, docId),
                gt(schema.operations.clock, clockDate),
              ),
            )
            .orderBy(schema.operations.clock);

          return serverOps.map((r) => r.operations as O[]);
        },

        deleteOperations: async ({ docId, count }) => {
          // Get the first `count` operations ordered by clock (oldest first)
          const toDelete = await tx
            .select({
              docId: schema.operations.docId,
              clock: schema.operations.clock,
            })
            .from(schema.operations)
            .where(eq(schema.operations.docId, docId))
            .orderBy(schema.operations.clock)
            .limit(count);

          if (toDelete.length > 0) {
            // Delete operations using their composite primary key (docId, clock)
            for (const op of toDelete) {
              await tx
                .delete(schema.operations)
                .where(
                  and(
                    eq(schema.operations.docId, op.docId),
                    eq(schema.operations.clock, op.clock),
                  ),
                );
            }
          }
        },

        saveOperations: async ({ docId, operations }) => {
          if (operations.length === 0) {
            // Return the latest clock for this docId
            const latestOp = await tx.query.operations.findFirst({
              where: eq(schema.operations.docId, docId),
              orderBy: (ops, { desc }) => [desc(ops.clock)],
            });
            return latestOp?.clock.getTime() ?? 0;
          }

          // Insert operations and return the DB-generated timestamp
          const inserted = await tx
            .insert(schema.operations)
            .values({ docId, operations: operations as unknown[] })
            .returning({ clock: schema.operations.clock });

          return inserted[0]!.clock.getTime();
        },

        saveSerializedDoc: async (_arg) => {
          // TODO: saveSerializedDoc needs userId to work with Postgres schema.
          // This will be called during operation squashing (not implemented yet).
          // Options:
          // 1. Pass userId through TransactionContext
          // 2. Query userId from operations table
          // 3. Refactor schema to not require userId on documents table
          throw new Error(
            "saveSerializedDoc not implemented for PostgresProvider yet - requires userId context",
          );
        },
      };

      return callback(ctx);
    });
  }
}
