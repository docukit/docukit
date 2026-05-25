import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { JsonDoc, Operations } from "@docukit/docnode";
import type {
  ServerProvider,
  ServerProviderContext,
} from "@docukit/docsync-react/server";
import { db, sqlite } from "./sqlite-db.ts";
import * as schema from "./sqlite-schema.ts";

const defaultDocTtlMs = 7 * 24 * 60 * 60 * 1000;
const defaultCleanupIntervalMs = 60 * 60 * 1000;

function parseJsonDoc(value: string): JsonDoc {
  return JSON.parse(value) as JsonDoc;
}

function parseOperations(value: string): Operations[] {
  return JSON.parse(value) as Operations[];
}

function cleanupExpiredDocs(ttlMs: number) {
  const cutoff = Date.now() - ttlMs;
  const lastActivityByDocId = new Map<string, number>();

  const documentRows = db
    .select({
      docId: schema.documents.docId,
      updatedAt: schema.documents.updatedAt,
    })
    .from(schema.documents)
    .all();
  for (const row of documentRows) {
    lastActivityByDocId.set(row.docId, row.updatedAt);
  }

  const operationRows = db
    .select({
      docId: schema.operations.docId,
      createdAt: schema.operations.createdAt,
    })
    .from(schema.operations)
    .all();
  for (const row of operationRows) {
    lastActivityByDocId.set(
      row.docId,
      Math.max(lastActivityByDocId.get(row.docId) ?? 0, row.createdAt),
    );
  }

  const expiredDocIds = [...lastActivityByDocId]
    .filter(([, lastActivity]) => lastActivity <= cutoff)
    .map(([docId]) => docId);

  for (const docId of expiredDocIds) {
    db.delete(schema.operations)
      .where(eq(schema.operations.docId, docId))
      .run();
    db.delete(schema.documents).where(eq(schema.documents.docId, docId)).run();
  }

  if (expiredDocIds.length > 0) {
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    sqlite.exec("vacuum");
  }
}

export function sqliteProvider({
  ttlMs = defaultDocTtlMs,
  cleanupIntervalMs = defaultCleanupIntervalMs,
}: { ttlMs?: number; cleanupIntervalMs?: number } = {}): ServerProvider<
  JsonDoc,
  Operations
> {
  let queue = Promise.resolve();

  function runExclusive<T>(run: () => Promise<T> | T): Promise<T> {
    const result = queue.then(run, run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  setInterval(() => {
    void runExclusive(() => {
      cleanupExpiredDocs(ttlMs);
    });
  }, cleanupIntervalMs);

  return {
    transaction<T>(
      mode: "readonly" | "readwrite",
      callback: (ctx: ServerProviderContext<JsonDoc, Operations>) => Promise<T>,
    ): Promise<T> {
      const runTransaction = async () => {
        const ctx: ServerProviderContext<JsonDoc, Operations> = {
          // eslint-disable-next-line @typescript-eslint/require-await -- sync SQLite implementation of async provider interface
          getSerializedDoc: async ({ docId }) => {
            const doc = db
              .select()
              .from(schema.documents)
              .where(eq(schema.documents.docId, docId))
              .get();

            return doc
              ? { serializedDoc: parseJsonDoc(doc.doc), clock: doc.clock }
              : undefined;
          },

          // eslint-disable-next-line @typescript-eslint/require-await -- sync SQLite implementation of async provider interface
          getOperations: async ({ docId, clock }) => {
            const rows = db
              .select({ operations: schema.operations.operations })
              .from(schema.operations)
              .where(
                and(
                  eq(schema.operations.docId, docId),
                  gt(schema.operations.clock, clock),
                ),
              )
              .orderBy(schema.operations.clock)
              .all();

            return rows.map((row) => parseOperations(row.operations));
          },

          // eslint-disable-next-line @typescript-eslint/require-await -- sync SQLite implementation of async provider interface
          deleteOperations: async ({ docId, count }) => {
            db.run(sql`
              delete from ${schema.operations}
              where ${schema.operations.docId} = ${docId}
                and ${schema.operations.clock} in (
                  select ${schema.operations.clock}
                  from ${schema.operations}
                  where ${schema.operations.docId} = ${docId}
                  order by ${schema.operations.clock}
                  limit ${count}
                )
            `);
          },

          // eslint-disable-next-line @typescript-eslint/require-await -- sync SQLite implementation of async provider interface
          saveOperations: async ({ docId, operations }) => {
            const now = Date.now();
            const latestOperation = db
              .select({ clock: schema.operations.clock })
              .from(schema.operations)
              .where(eq(schema.operations.docId, docId))
              .orderBy(desc(schema.operations.clock))
              .limit(1)
              .get();
            const storedDoc = db
              .select({ clock: schema.documents.clock })
              .from(schema.documents)
              .where(eq(schema.documents.docId, docId))
              .get();
            const currentClock = Math.max(
              latestOperation?.clock ?? 0,
              storedDoc?.clock ?? 0,
            );

            if (operations.length === 0) return currentClock;

            const nextClock = currentClock + 1;
            db.insert(schema.operations)
              .values({
                docId,
                clock: nextClock,
                operations: JSON.stringify(operations),
                createdAt: now,
              })
              .run();
            db.update(schema.documents)
              .set({ updatedAt: now })
              .where(eq(schema.documents.docId, docId))
              .run();
            return nextClock;
          },

          // eslint-disable-next-line @typescript-eslint/require-await -- sync SQLite implementation of async provider interface
          saveSerializedDoc: async ({ docId, serializedDoc, clock }) => {
            const now = Date.now();
            db.insert(schema.documents)
              .values({
                docId,
                doc: JSON.stringify(serializedDoc),
                clock,
                createdAt: now,
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: schema.documents.docId,
                set: {
                  doc: JSON.stringify(serializedDoc),
                  clock,
                  updatedAt: now,
                },
              })
              .run();
          },
        };

        sqlite.exec(mode === "readwrite" ? "begin immediate" : "begin");
        try {
          const result = await callback(ctx);
          sqlite.exec("commit");
          return result;
        } catch (error) {
          sqlite.exec("rollback");
          throw error;
        }
      };

      return runExclusive(runTransaction);
    },
  };
}
