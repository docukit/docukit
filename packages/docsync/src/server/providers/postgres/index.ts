import { queryClient } from "./schema.js";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type { ServerProvider } from "../../types.js";
import type { DocSyncEvents } from "../../../shared/types.js";
import { eq, gt, and, sql } from "drizzle-orm";
import type { Operations } from "docnode";

export class PostgresProvider<S, O> implements ServerProvider<S, O> {
  private _db = drizzle(queryClient, { schema });

  async sync(
    req: DocSyncEvents<S, O>["sync-operations"]["request"],
  ): Promise<DocSyncEvents<S, O>["sync-operations"]["response"]> {
    const { docId, operations, clock: clientClock } = req;
    const clientClockDate = new Date(clientClock);

    return await this._db.transaction(async (tx) => {
      // 1. Get operations the client doesn't have
      //    We query BEFORE inserting so we don't return the client's own operations
      const serverOps = await tx
        .select({ operations: schema.operations.operations })
        .from(schema.operations)
        .where(
          and(
            eq(schema.operations.docId, docId),
            gt(schema.operations.clock, clientClockDate),
          ),
        )
        .orderBy(schema.operations.clock);

      // 2. Get server document only if its clock > client clock
      const serverDoc = await tx.query.documents.findFirst({
        where: and(
          eq(schema.documents.docId, docId),
          gt(schema.documents.clock, clientClockDate),
        ),
      });

      // 3. Save client operations if provided (single row with array, clock = NOW())
      //    Use RETURNING to get the DB-generated timestamp
      const inserted =
        operations && operations.length > 0
          ? await tx
              .insert(schema.operations)
              .values({
                docId,
                operations,
              })
              .returning({ clock: schema.operations.clock })
          : [];
      const newClock = inserted[0]!.clock.getTime();

      // 4. Return data
      return {
        docId,
        operations:
          serverOps.length > 0
            ? (serverOps.map((r) => r.operations) as O[])
            : null,
        serializedDoc: (serverDoc?.doc ?? null) as S,
        clock: newClock,
      };
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
        operations: operations[0],
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
          RETURNING "docId", operations
        )
        SELECT "docId" AS doc_id, ARRAY_AGG(operations ORDER BY clock) AS operations_list
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
