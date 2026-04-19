import { eq, gt, and } from "drizzle-orm";
import type { JsonDoc, Operations } from "@docukit/docnode";
import type { ServerProvider } from "@docukit/docsync-react/server";
import { db } from "./db.ts";
import * as schema from "./postgres-schema.ts";

export const postgresProvider: ServerProvider<JsonDoc, Operations> = {
  async transaction(mode, callback) {
    const accessMode = mode === "readonly" ? "read only" : "read write";
    return await db.transaction(
      async (tx) =>
        callback({
          getSerializedDoc: async ({ docId }) => {
            const doc = await tx.query.documents.findFirst({
              where: eq(schema.documents.docId, docId),
            });
            return doc
              ? {
                  serializedDoc: JSON.parse(doc.doc) as JsonDoc,
                  clock: doc.clock,
                }
              : undefined;
          },

          getOperations: async ({ docId, clock }) => {
            const rows = await tx
              .select({ operations: schema.operations.operations })
              .from(schema.operations)
              .where(
                and(
                  eq(schema.operations.docId, docId),
                  gt(schema.operations.clock, clock),
                ),
              )
              .orderBy(schema.operations.clock);
            return rows.map((r) => JSON.parse(r.operations) as Operations[]);
          },

          deleteOperations: async ({ docId, count }) => {
            const toDelete = await tx
              .select({ clock: schema.operations.clock })
              .from(schema.operations)
              .where(eq(schema.operations.docId, docId))
              .orderBy(schema.operations.clock)
              .limit(count);

            for (const op of toDelete) {
              await tx
                .delete(schema.operations)
                .where(
                  and(
                    eq(schema.operations.docId, docId),
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
              return latestOp?.clock ?? 0;
            }

            const inserted = await tx
              .insert(schema.operations)
              .values({ docId, operations: JSON.stringify(operations) })
              .returning({ clock: schema.operations.clock });
            return inserted[0]!.clock;
          },

          // eslint-disable-next-line @typescript-eslint/require-await -- not implemented yet
          saveSerializedDoc: async () => {
            throw new Error(
              "saveSerializedDoc not implemented for postgresProvider yet - requires userId context",
            );
          },
        }),
      { accessMode },
    );
  },
};
