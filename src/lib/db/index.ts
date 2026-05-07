import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

// In production we always use a real Postgres via DATABASE_URL.
// In local dev (no DATABASE_URL) we fall back to PGlite for zero-config DX.
// Tests build their own PGlite instance in __tests__/helpers.ts and never hit
// this module, so the prod-shape cast below has no effect on the test suite.
type DrizzleDb = ReturnType<typeof drizzlePostgres<typeof schema>>;

const databaseUrl = process.env.DATABASE_URL;

const globalForDb = globalThis as unknown as {
  __sanctumDb: DrizzleDb | undefined;
  __sanctumPgClient: ReturnType<typeof postgres> | undefined;
  __sanctumPglite: PGlite | undefined;
};

function buildDb(): DrizzleDb {
  if (databaseUrl) {
    const client =
      globalForDb.__sanctumPgClient ??
      postgres(databaseUrl, {
        max: 10,
        idle_timeout: 20,
        connect_timeout: 10,
        prepare: false,
      });
    globalForDb.__sanctumPgClient = client;
    return drizzlePostgres(client, { schema });
  }

  const pglite = globalForDb.__sanctumPglite ?? new PGlite("./data/pglite");
  globalForDb.__sanctumPglite = pglite;
  // PGlite's drizzle output is structurally compatible with postgres-js for our
  // query usage (select/insert/update/delete/transaction). We assert the prod
  // shape here so router code only depends on a single Database type.
  return drizzlePglite({ client: pglite, schema }) as unknown as DrizzleDb;
}

export const db: DrizzleDb = globalForDb.__sanctumDb ?? buildDb();
globalForDb.__sanctumDb = db;

export const isUsingPostgres = Boolean(databaseUrl);
