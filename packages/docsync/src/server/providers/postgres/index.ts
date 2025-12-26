import { queryClient } from "./schema.js";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type {
  ClientProvider,
  TransactionContext,
} from "../../../client/types.js";
import { eq, asc } from "drizzle-orm";

export class PostgresProvider<S, O> implements ClientProvider<S, O> {
  private _db = drizzle(queryClient, { schema });

  private _createContext(
    tx: Parameters<Parameters<typeof this._db.transaction>[0]>[0],
  ): TransactionContext<S, O> {
    return {
      async getSerializedDoc(docId: string) {
        const row = await tx.query.documents.findFirst({
          where: eq(schema.documents.docId, docId),
          columns: { doc: true, clock: true },
        });
        if (!row) return undefined;
        return {
          serializedDoc: row.doc as S,
          clock: row.clock.getTime(),
        };
      },

      async getOperations({ docId }: { docId: string }) {
        const ops = await tx
          .select({ o: schema.operations.o })
          .from(schema.operations)
          .where(eq(schema.operations.docId, docId))
          .orderBy(asc(schema.operations.clock));
        return ops.map((row) => row.o as O);
      },

      async deleteOperations({
        docId,
        count,
      }: {
        docId: string;
        count: number;
      }) {
        if (count <= 0) return;
        // Get the clock values of oldest `count` operations
        const toDelete = await tx
          .select({ clock: schema.operations.clock })
          .from(schema.operations)
          .where(eq(schema.operations.docId, docId))
          .orderBy(asc(schema.operations.clock))
          .limit(count);

        if (toDelete.length > 0) {
          // Delete by docId and clock (since there's no id column)
          for (const { clock } of toDelete) {
            await tx
              .delete(schema.operations)
              .where(eq(schema.operations.clock, clock));
          }
        }
      },

      async saveOperations({
        docId,
        operations,
      }: {
        docId: string;
        operations: O;
      }) {
        await tx.insert(schema.operations).values({
          docId,
          o: operations,
        });
      },

      async saveSerializedDoc({
        docId,
        serializedDoc,
        clock,
      }: {
        docId: string;
        serializedDoc: S;
        clock: number;
      }) {
        // TODO: userId should come from auth context
        const userId = "system";
        await tx
          .insert(schema.documents)
          .values({
            userId,
            docId,
            doc: serializedDoc,
            clock: new Date(clock),
          })
          .onConflictDoUpdate({
            target: [schema.documents.docId, schema.documents.userId],
            set: {
              doc: serializedDoc,
              clock: new Date(clock),
            },
          });
      },
    };
  }

  async transaction<T>(
    mode: "readonly" | "readwrite",
    callback: (ctx: TransactionContext<S, O>) => Promise<T>,
  ): Promise<T> {
    const accessMode = mode === "readonly" ? "read only" : "read write";
    return await this._db.transaction(
      async (tx) => {
        const ctx = this._createContext(tx);
        return await callback(ctx);
      },
      { accessMode },
    );
  }
}
