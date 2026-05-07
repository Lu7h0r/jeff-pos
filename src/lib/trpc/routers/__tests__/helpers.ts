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
  // cash_sessions and cash_movements moved before orders because Batch 4
  // adds orders.cash_session_id NOT NULL FK -> cash_sessions.id. Keep this
  // section FK-safe: cash_sessions before any table that references it.
  schema.cashSessions,
  schema.cashMovements,
  schema.orders,
  schema.serviceAgreements,
  schema.orderItems,
  // order_payments references orders, payment_methods and cash_sessions —
  // all already declared above.
  schema.orderPayments,
  schema.serviceAgreementPayments,
  // inventory_balances and inventory_movements both reference businesses,
  // locations and products — all already declared above. Keep this last so
  // FK targets exist when DDL is applied in order.
  schema.inventoryBalances,
  schema.inventoryMovements,
  // Batch 6: expenses (operational P&L) and procurements (inventory
  // purchases). FK-safe order: expense_categories before expense_entries,
  // suppliers before purchase_orders, purchase_orders before purchase_items.
  // All reference businesses/locations/payment_methods/cash_sessions which
  // are already declared above.
  schema.expenseCategories,
  schema.expenseEntries,
  schema.suppliers,
  schema.purchaseOrders,
  schema.purchaseItems,
  // Batch 8: staff, stations, services, commissions, location-level perms.
  // FK-safe order: staff_members before workstations (workstations don't ref
  // staff but station_rentals does); workstations before station_rentals
  // (which refs both); service_sales after order_items + staff_members; and
  // commission_estimates after service_sales + staff_members.
  schema.staffMembers,
  schema.serviceAgreementSessions,
  schema.serviceAgreementCommissions,
  schema.serviceAgreementConsumptionTemplates,
  schema.serviceAgreementMedia,
  schema.customerMessageConsents,
  schema.followUpOutboxEvents,
  schema.workstations,
  schema.stationRentals,
  schema.serviceSales,
  schema.commissionEstimates,
  schema.locationMembers,
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
 *
 * Defaults `role` to `"owner"` so tests that exercise routers with the new
 * role-guard middleware (Auth Management batch) keep passing without having
 * to opt into a role explicitly. Tests that need to assert FORBIDDEN for a
 * specific role must pass it explicitly (e.g. `role: "cashier"`).
 */
export function makeContext(
  uid: string,
  active?: {
    businessId?: number | null;
    locationId?: number | null;
    role?: string | null;
    isLocationScoped?: boolean;
    effectiveLocationIds?: number[];
  },
) {
  return {
    user: makeUser(uid),
    activeBusinessId: active?.businessId ?? null,
    activeLocationId: active?.locationId ?? null,
    activeRole: active?.role === undefined ? "owner" : active.role,
    isLocationScoped: active?.isLocationScoped ?? false,
    effectiveLocationIds: active?.effectiveLocationIds ?? [],
  };
}
