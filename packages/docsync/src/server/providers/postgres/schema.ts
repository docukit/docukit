import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import postgres from "postgres";

if (!process.env.DOCNODE_DB_URL)
  throw new Error("env var DOCNODE_DB_URL not found");
export const queryClient = postgres(process.env.DOCNODE_DB_URL);

export const documents = pgTable("docsync-documents", {
  userId: varchar("userId", { length: 26 }).notNull(),
  docId: varchar("docId", { length: 26 }).notNull().primaryKey(),
  doc: jsonb("doc").notNull(),
  clock: timestamp("clock", { withTimezone: true, mode: "date" }).notNull(),
  permissions: jsonb("permissions"), // ??
});

export const operations = pgTable(
  "docsync-operations",
  {
    docId: varchar("docId", { length: 26 }).notNull(),
    operations: jsonb("operations").notNull(),
    clock: timestamp("clock", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.docId, table.clock] })],
);

export const snapshots_deltas = pgTable(
  "snapshots_deltas",
  {
    docId: varchar("docId", { length: 26 }).notNull(),
    docnodeId: varchar("docnodeId", { length: 26 }).notNull(),
    data: jsonb("data"),

    // Cada vez que un nodo es modificado, se guarda en la tabla snapshots-deltas con un snapshotTimestamp vacío.
    // Cuando el snapshot "cierra", a todos los nodos del documento que no tienen un snapshotTimestamp, se les asigna el timestamp del snapshot.
    // Suena como una feature que podría implementar una BD. Básicamente si quiero volver a un estado X, puedo pedirle al proveedor de la BD que
    // me de un backup de la tabla (aunque eso me restauraría todos los documentos, no solo uno). Además, hay que ver si el proveedor de la BD lo
    // provee a nivel de tabla (duplica) o a nivel de fila (duplica solo los nodos que cambiaron).
    snapshot_timestamp: timestamp("snapshot_timestamp").defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.docId, table.docnodeId] })],
);
