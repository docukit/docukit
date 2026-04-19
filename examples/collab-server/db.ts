import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./postgres-schema.ts";

const queryClient = postgres(process.env.DOCNODE_DB_URL!);

export const db = drizzle(queryClient, { schema });
