import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./src/server/providers/postgres/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DOCNODE_DB_URL!,
  },
});
