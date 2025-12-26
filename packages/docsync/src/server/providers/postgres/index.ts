import { queryClient } from "./schema.js";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type { ServerProvider } from "../../types.js";
import { sql, eq, gt, and } from "drizzle-orm";
import type { Operations } from "docnode";

export class PostgresProvider<S, O> implements ServerProvider<S, O> {
  private _db = drizzle(queryClient, { schema });

  async sync(
    req: Parameters<ServerProvider<S, O>["sync"]>[0],
  ): ReturnType<ServerProvider<S, O>["sync"]> {
    return []; // TODO
    return await this._db.transaction(async (tx) => {
      const results: Awaited<ReturnType<ServerProvider<S, O>["sync"]>> = [];

      for (const { docId, operations, clock: clientClock } of req) {
        const clientClockDate = new Date(clientClock);

        // 1. Get operations the client doesn't have (clock > clientClock)
        //    We query BEFORE inserting so we don't return the client's own operations
        const serverOps = await tx
          .select({ o: schema.operations.o, clock: schema.operations.clock })
          .from(schema.operations)
          .where(
            and(
              eq(schema.operations.docId, docId),
              gt(schema.operations.clock, clientClockDate),
            ),
          )
          .orderBy(schema.operations.clock);

        // 2. Get server document (for serializedDoc if needed)
        const serverDoc = await tx.query.documents.findFirst({
          where: eq(schema.documents.docId, docId),
        });

        // 3. Save client operations if provided (clock = NOW(), assigned by DB)
        if (operations && operations.length > 0) {
          await tx.insert(schema.operations).values(
            operations.map((op) => ({
              docId,
              o: op,
              // clock defaults to NOW() via defaultNow()
            })),
          );
        }

        // 4. Determine the latest clock
        //    - If we have server ops, use the max clock from those
        //    - Otherwise use the client's clock (no new data)
        const latestClock =
          serverOps.length > 0
            ? serverOps[serverOps.length - 1]!.clock.getTime()
            : clientClock;

        // 5. Only return data if server has newer content
        const hasNewerData = serverOps.length > 0;

        results.push({
          docId,
          operations: hasNewerData ? (serverOps.map((r) => r.o) as O[]) : null,
          serializedDoc: (hasNewerData ? serverDoc?.doc : null) as S,
          clock: latestClock,
        });
      }

      return results;
    });
  }

  async saveOperations(operations: Operations) {
    const firstOp = operations[0][0];
    let docId = "root";
    if (firstOp) {
      switch (firstOp[0]) {
        case 0:
          docId = firstOp[2] || "root";
          break;
        case 1:
          docId = firstOp[1];
          break;
        case 2:
          docId = firstOp[1];
          break;
      }
    }
    await this._db
      .insert(schema.operations)
      .values({
        o: operations[0],
        docId,
      })
      .execute();
    await this.squashAndMergeOperations();
  }

  async squashAndMergeOperations() {
    const operations = await this._db.execute(
      sql`
        WITH deleted_ops AS (
          DELETE FROM ${schema.operations}
          WHERE "docId" = (SELECT "docId" FROM ${schema.operations} ORDER BY clock LIMIT 1)
          RETURNING "docId", o
        )
        SELECT "docId" AS doc_id, ARRAY_AGG(o ORDER BY clock) AS operations_list
        FROM deleted_ops
        GROUP BY "docId";
      `,
    );

    if (!operations[0]) return;
    const docId = operations[0].doc_id as string;

    const currentDoc = await this._db.query.documents.findFirst({
      where: eq(schema.documents.docId, docId),
    });

    console.log("squashAndMergeOperations3", operations);
    console.log("squashAndMergeOperations4", currentDoc);
    // TODO: Apply operations to currentDoc and save
  }

  async getDocIdsChangedSince(_lastSync?: string) {
    const docIds = await this._db
      .select({ docId: schema.documents.docId })
      .from(schema.documents);
    return docIds.map((doc) => doc.docId);
  }
}
