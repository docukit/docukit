import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./sqlite-schema.ts";

export const sqlitePath =
  process.env.DOCSYNC_SQLITE_PATH ?? "../.context/docsync.sqlite";

mkdirSync(dirname(sqlitePath), { recursive: true });

export const sqlite = new Database(sqlitePath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");

sqlite.exec(`
  create table if not exists documents (
    doc_id text primary key not null,
    doc text not null,
    clock integer not null,
    created_at integer not null,
    updated_at integer not null
  );

  create index if not exists documents_updated_at_idx
    on documents(updated_at);

  create table if not exists operations (
    doc_id text not null,
    clock integer not null,
    operations text not null,
    created_at integer not null,
    primary key (doc_id, clock)
  );

  create index if not exists operations_doc_clock_idx
    on operations(doc_id, clock);

  create index if not exists operations_created_at_idx
    on operations(created_at);
`);

export const db = drizzle(sqlite, { schema });
