import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./postgres-schema.ts";

const queryClient = postgres(
  process.env.DOCNODE_DB_URL ??
    "postgres://docukit:docukit@localhost:5433/docukit",
  {
    onnotice: () => void {},
    connect_timeout: 5,
    idle_timeout: 0,
    connection: { application_name: "docukit" },
  },
);

export const db = drizzle(queryClient, { schema });
