import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle",
  schema: "./postgres-schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DOCNODE_DB_URL ??
      "postgres://docukit:docukit@localhost:5433/docukit",
  },
});
