import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.DATABASE_URL;

// Two-mode config:
// - dev (no DATABASE_URL): PGlite at ./data/pglite, drizzle-kit push for fast iteration.
// - prod (DATABASE_URL set): real Postgres, drizzle-kit migrate against versioned files.
export default defineConfig(
  databaseUrl
    ? {
        dialect: "postgresql",
        schema: "./src/lib/db/schema.ts",
        out: "./drizzle/migrations",
        dbCredentials: { url: databaseUrl },
        strict: true,
        verbose: true,
      }
    : {
        dialect: "postgresql",
        driver: "pglite",
        schema: "./src/lib/db/schema.ts",
        out: "./drizzle/migrations",
        dbCredentials: { url: "./data/pglite" },
      },
);
