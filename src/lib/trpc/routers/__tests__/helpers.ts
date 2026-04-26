import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

// FK-safe order: referenced tables before referencing tables.
// schema.user (Better Auth) must come first because business_members has FK
// to user.id. businesses must come before business_members and locations
// (both reference businesses.id) and before customers/paymentMethods which
// gained nullable business_id in Batch 1.
const TABLES: PgTable[] = [
  schema.user,
  schema.businesses,
  schema.businessMembers,
  schema.locations,
  schema.products,
  schema.customers,
  schema.paymentMethods,
  schema.orders,
  schema.orderItems,
  schema.transactions,
];

// All identifiers are double-quoted to avoid clashes with Postgres reserved
// words (e.g. Better Auth's "user" table). Without quotes, CREATE TABLE user
// fails with syntax error 42601.
function tableToDDL(table: PgTable): string {
  const { name, columns, foreignKeys } = getTableConfig(table);

  const colDefs = columns.map((col) => {
    const sqlType = col.getSQLType();
    const isSerial = sqlType === "serial";
    const parts: string[] = [`"${col.name}"`, sqlType];

    if (col.primary) parts.push("PRIMARY KEY");
    if (col.notNull && !isSerial) parts.push("NOT NULL");
    if (col.isUnique) parts.push("UNIQUE");
    if (col.hasDefault && !isSerial) {
      if (sqlType.startsWith("timestamp")) {
        parts.push("DEFAULT NOW()");
      } else {
        // Drizzle exposes literal defaults on col.default. Emit them so PG
        // resolves Drizzle's "default" keyword in INSERT statements. Functions
        // and SQL expressions are skipped (Drizzle resolves them at runtime).
        const def = (col as unknown as { default?: unknown }).default;
        if (typeof def === "string") {
          parts.push(`DEFAULT '${def.replace(/'/g, "''")}'`);
        } else if (typeof def === "number" || typeof def === "boolean") {
          parts.push(`DEFAULT ${def}`);
        }
      }
    }

    return parts.join(" ");
  });

  const fkDefs = foreignKeys.map((fk) => {
    const ref = fk.reference();
    const col = ref.columns[0].name;
    const refTable = getTableName(ref.foreignColumns[0].table);
    const refCol = ref.foreignColumns[0].name;
    return `FOREIGN KEY ("${col}") REFERENCES "${refTable}"("${refCol}")`;
  });

  return `CREATE TABLE IF NOT EXISTS "${name}" (\n  ${[...colDefs, ...fkDefs].join(",\n  ")}\n);`;
}

export const SCHEMA_DDL = TABLES.map(tableToDDL).join("\n\n");

export function createTestDb() {
  const pg = new PGlite();
  const db = drizzle({ client: pg, schema });
  return { pg, db };
}

export function makeUser(id: string) {
  return {
    id,
    name: "Test",
    email: `${id}@test.com`,
    emailVerified: false,
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/**
 * Builds a complete TRPCContext-shaped object for tests. Use when a test
 * needs to exercise router behaviour that depends on activeBusinessId or
 * activeLocationId. For tests that only need an authenticated user, passing
 * `{ user: makeUser(uid) }` to the caller factory still works because router
 * code uses `ctx.activeBusinessId != null` (catches both null and undefined).
 */
export function makeContext(
  uid: string,
  active?: {
    businessId?: number | null;
    locationId?: number | null;
    role?: string | null;
  },
) {
  return {
    user: makeUser(uid),
    activeBusinessId: active?.businessId ?? null,
    activeLocationId: active?.locationId ?? null,
    activeRole: active?.role ?? null,
  };
}
