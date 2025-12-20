import { queryClient } from "./schema.js";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type { ServerProvider } from "../../index.js";
import { sql, eq } from "drizzle-orm";
import type { Operations } from "docnode";

export class PostgresProvider implements ServerProvider {
  private _db = drizzle(queryClient, { schema });

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
        i: docId,
      })
      .execute();
    await this.squashAndMergeOperations();
  }

  async squashAndMergeOperations() {
    // const operations0 = await this.db.execute(
    //   sql`DELETE FROM ${schema.operations}
    //       WHERE i = (SELECT i FROM ${schema.operations} LIMIT 1)
    //       RETURNING i, o;`
    // );

    const operations = await this._db.execute(
      sql`
        WITH deleted_ops AS (
          DELETE FROM ${schema.operations}
          WHERE i = (SELECT i FROM ${schema.operations} ORDER BY i LIMIT 1)
          RETURNING i, o
        )
        SELECT i AS doc_id, ARRAY_AGG(o) AS operations_list
        FROM deleted_ops
        GROUP BY i;
      `,
    );

    const docId = operations[0]!.doc_id as string;

    const currentDoc = await this._db.query.documents.findFirst({
      where: eq(schema.documents.docId, docId),
    });

    console.log("squashAndMergeOperations3", operations);
    console.log("squashAndMergeOperations4", currentDoc);
    // Si no hay operaciones, no hacemos nada
    // if (!operations) return;

    // Extraemos el docId y las operaciones
    // const docId = result.rows[0].i;
    // const operationsList = result.rows.map(row => row.o); // Lista de operaciones JSON

    // // Squash and merge las operaciones
    // const squashedDoc = squashOperations(operationsList);

    // // Aplicamos el resultado al documento correspondiente
    // await this.db
    //   .update(schema.documents)
    //   .set({ content: squashedDoc }) // Asume que hay un campo "content"
    //   .where(eq(schema.documents.docId, docId));
  }

  async getDocIdsChangedSince(_lastSync?: string) {
    const docIds = await this._db
      .select({ docId: schema.documents.docId })
      .from(schema.documents);
    return docIds.map((doc) => doc.docId);
  }
}
