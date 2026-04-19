import {
  bigint,
  bigserial,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const documents = pgTable("documents", {
  docId: varchar("docId", { length: 26 }).notNull().primaryKey(),
  doc: text("doc").notNull(),
  // matches the highest operations.clock incorporated into this snapshot
  clock: bigint("clock", { mode: "number" }).notNull(),
  // optional: add application-specific fields like userId or updatedAt
  userId: varchar("userId", { length: 26 }).notNull(),
  updatedAt: timestamp("updatedAt", { precision: 3, withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const operations = pgTable(
  "operations",
  {
    docId: varchar("docId", { length: 26 }).notNull(),
    clock: bigserial("clock", { mode: "number" }).notNull(),
    operations: text("operations").notNull(),
    // optional: add application-specific fields like createdAt
    createdAt: timestamp("createdAt", { precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.docId, table.clock] })],
);
