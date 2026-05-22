import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const documents = sqliteTable(
  "documents",
  {
    docId: text("doc_id").notNull().primaryKey(),
    doc: text("doc").notNull(),
    clock: integer("clock").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("documents_updated_at_idx").on(table.updatedAt)],
);

export const operations = sqliteTable(
  "operations",
  {
    docId: text("doc_id").notNull(),
    clock: integer("clock").notNull(),
    operations: text("operations").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.docId, table.clock] }),
    index("operations_doc_clock_idx").on(table.docId, table.clock),
    index("operations_created_at_idx").on(table.createdAt),
  ],
);
