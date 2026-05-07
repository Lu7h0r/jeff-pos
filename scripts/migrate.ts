import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required to run migrations.");
  process.exit(1);
}

async function main() {
  // max=1: migrator must run sequentially.
  const client = postgres(databaseUrl!, { max: 1, prepare: false });
  const db = drizzle(client);

  console.log("Applying migrations from ./drizzle/migrations…");
  await migrate(db, { migrationsFolder: "./drizzle/migrations" });
  console.log("Migrations applied.");

  await client.end();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
