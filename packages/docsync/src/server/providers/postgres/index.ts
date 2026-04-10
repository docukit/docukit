/* eslint-disable @typescript-eslint/no-empty-object-type */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, gt, and, sql } from "drizzle-orm";
import * as schema from "./schema.js";
import type { ServerProvider, ServerProviderContext } from "../../types.js";

export function postgresProvider<S extends {} = {}, O extends {} = {}>(config: {
  url: string;
}): ServerProvider<S, O> {
  const queryClient = postgres(config.url, {
    onnotice: () => void {},
    connect_timeout: 5,
    idle_timeout: 0,
    connection: { application_name: "docukit" },
  });

  const db = drizzle(queryClient, { schema });

  let initError: Error | undefined;
  const initPromise = ensureTables(db).catch((err: unknown) => {
    initError = err instanceof Error ? err : new Error(String(err));
    console.error(initError.message);
  });

  return {
    async transaction<T>(
      _mode: "readonly" | "readwrite",
      callback: (ctx: ServerProviderContext<S, O>) => Promise<T>,
    ): Promise<T> {
      await initPromise;
      if (initError) throw initError;

      return await db.transaction(async (tx) => {
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
          saveSerializedDoc: async (_arg) => {
            // TODO: saveSerializedDoc needs userId to work with Postgres schema.
            // This will be called during operation squashing (not implemented yet).
            // Options:
            // 1. Pass userId through TransactionContext
            // 2. Query userId from operations table
            // 3. Refactor schema to not require userId on documents table
            throw new Error(
              "saveSerializedDoc not implemented for postgresProvider yet - requires userId context",
            );
          },
        };

        return callback(ctx);
      });
    },
  };
}

async function ensureTables(db: ReturnType<typeof drizzle>): Promise<void> {
  // 1. Verify connection
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    throw new Error(
      "[DocSync] Failed to connect to PostgreSQL. " +
        "Check that the URL is correct and the database is running.",
    );
  }

  // 2. Create tables if they don't exist.
  //    Raw SQL because drizzle-kit's pushSchema (which could derive this from schema.ts)
  //    is a 2.8 MB non-tree-shakeable bundle — not worth adding as a runtime dependency.
  //    If you modify these, also update the Drizzle schema in schema.ts.
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "_docsync_documents" (
        "userId" varchar(26) NOT NULL,
        "docId" varchar(26) NOT NULL PRIMARY KEY,
        "doc" jsonb NOT NULL,
        "clock" timestamptz(3) NOT NULL,
      )
    `);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "_docsync_operations" (
        "docId" varchar(26) NOT NULL,
        "operations" jsonb NOT NULL,
        "clock" timestamptz(3) NOT NULL DEFAULT now(),
        PRIMARY KEY ("docId", "clock")
      )
    `);
  } catch {
    // CREATE TABLE failed (e.g., read-only database). Check if tables already exist.
    const rows = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('_docsync_documents', '_docsync_operations')
    `);
    const found = new Set(rows.map((r) => r.table_name as string));
    if (!found.has("_docsync_documents") || !found.has("_docsync_operations")) {
      throw new Error(
        "[DocSync] Required tables (_docsync_documents, _docsync_operations) do not exist " +
          "and could not be created. Grant CREATE permissions or create them manually.",
      );
    }
  }
}
