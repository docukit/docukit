import {
  customType,
  pgTable,
  serial,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { queryClient } from "../postgres/schema.js";

const bytea = customType<{ data: Uint8Array }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value) {
    if (Buffer.isBuffer(value)) return new Uint8Array(value);
    if (value instanceof Uint8Array) return value;
    throw new Error(`Unexpected bytea value type: ${typeof value}`);
  },
  toDriver(value) {
    return Buffer.from(value);
  },
});

export { queryClient };

export const binaryDocuments = pgTable("docsync-binary-documents", {
  userId: varchar("userId", { length: 26 }).notNull(),
  docId: varchar("docId", { length: 26 }).notNull().primaryKey(),
  doc: bytea("doc").notNull(),
  clock: timestamp("clock", { precision: 3, withTimezone: true }).notNull(),
});

export const binaryOperations = pgTable("docsync-binary-operations", {
  id: serial("id").primaryKey(),
  docId: varchar("docId", { length: 26 }).notNull(),
  operations: bytea("operations").notNull(),
  clock: timestamp("clock", { precision: 3, withTimezone: true })
    .notNull()
    .defaultNow(),
});
