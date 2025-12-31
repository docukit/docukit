import { queryClient } from "./schema.js";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type { ServerProvider } from "../../types.js";
import type { DocSyncEvents } from "../../../shared/types.js";
import { eq, gt, and } from "drizzle-orm";

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
}
