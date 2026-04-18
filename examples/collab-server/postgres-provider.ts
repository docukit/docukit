/* eslint-disable @typescript-eslint/no-empty-object-type */
import { eq, gt, and } from "drizzle-orm";
import type {
  ServerProvider,
  ServerProviderContext,
} from "@docukit/docsync-react/server";
import { db } from "./db.ts";
import * as schema from "./postgres-schema.ts";

type S = {};
type O = {};

export const postgresProvider: ServerProvider<S, O> = {
  async transaction(mode, callback) {
    const accessMode = mode === "readonly" ? "read only" : "read write";
    return await db.transaction(
      async (tx) => {
        const ctx: ServerProviderContext<S, O> = {
          getSerializedDoc: async (docId) => {
            const doc = await tx.query.documents.findFirst({
              where: eq(schema.documents.docId, docId),
            });
            return doc
              ? { serializedDoc: doc.doc as S, clock: doc.clock.getTime() }
              : undefined;
          },

          getOperations: async ({ docId, clock }) => {
            const serverOps = await tx
              .select({ operations: schema.operations.operations })
              .from(schema.operations)
              .where(
                and(
                  eq(schema.operations.docId, docId),
                  gt(schema.operations.clock, new Date(clock)),
                ),
              )
              .orderBy(schema.operations.clock);
            return serverOps.map((r) => r.operations as O[]);
          },

          deleteOperations: async ({ docId, count }) => {
            const toDelete = await tx
              .select({
                docId: schema.operations.docId,
                clock: schema.operations.clock,
              })
              .from(schema.operations)
              .where(eq(schema.operations.docId, docId))
              .orderBy(schema.operations.clock)
              .limit(count);

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
          },

          saveOperations: async ({ docId, operations }) => {
            if (operations.length === 0) {
              const latestOp = await tx.query.operations.findFirst({
                where: eq(schema.operations.docId, docId),
                orderBy: (ops, { desc }) => [desc(ops.clock)],
              });
              return latestOp?.clock.getTime() ?? 0;
            }

            const inserted = await tx
              .insert(schema.operations)
              .values({ docId, operations: operations as unknown[] })
              .returning({ clock: schema.operations.clock });
            return inserted[0]!.clock.getTime();
          },

          // eslint-disable-next-line @typescript-eslint/require-await -- not implemented yet
          saveSerializedDoc: async () => {
            throw new Error(
              "saveSerializedDoc not implemented for postgresProvider yet - requires userId context",
            );
          },
        };

        return callback(ctx);
      },
      { accessMode },
    );
  },
};
