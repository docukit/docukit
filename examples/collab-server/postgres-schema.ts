import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const documents = pgTable("_docsync_documents", {
  userId: varchar("userId", { length: 26 }).notNull(),
  docId: varchar("docId", { length: 26 }).notNull().primaryKey(),
  doc: text("doc").notNull(),
  clock: timestamp("clock", { precision: 3, withTimezone: true }).notNull(),
});

export const operations = pgTable(
  "_docsync_operations",
  {
    docId: varchar("docId", { length: 26 }).notNull(),
    operations: text("operations").notNull(),
    clock: timestamp("clock", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.docId, table.clock] })],
);
