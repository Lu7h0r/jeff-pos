import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  timestamp,
  boolean,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { user } from "./auth-schema";

// Re-export Better Auth tables so drizzle-kit picks them up
export {
  user,
  session,
  account,
  verification,
  userRelations,
  sessionRelations,
  accountRelations,
} from "./auth-schema";

// ── Businesses ──────────────────────────────────────────────────────────────
export const businesses = pgTable("businesses", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Business Members ────────────────────────────────────────────────────────
// Roles enforcement lives in zod schemas at the router layer (no DB CHECK
// constraint to keep tableToDDL helper simple). Allowed roles: owner, manager,
// cashier, artist. Status: active, suspended, removed.
export const businessMembers = pgTable("business_members", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  user_id: text("user_id")
    .notNull()
    .references(() => user.id),
  role: varchar("role", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Locations ───────────────────────────────────────────────────────────────
// slug is not globally unique on purpose — Amparo could exist in multiple
// businesses. Uniqueness within a business is enforced at the router layer
// in Batch 2+ when location creation is exposed.
export const locations = pgTable("locations", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Products ────────────────────────────────────────────────────────────────
// Batch 3 augments products with business_id (nullable for legacy demo rows),
// sku, cost_amount and status. The pre-existing in_stock column stays as a
// decorative legacy field: demo seed.ts and pre-Batch-3 admin pages still
// read it. Real on-hand quantities live in inventory_balances per location.
// Allowed status values (enforced in zod): active, draft, archived.
export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  price: integer("price").notNull(),
  in_stock: integer("in_stock").notNull(),
  user_uid: varchar("user_uid", { length: 255 }).notNull(),
  category: varchar("category", { length: 50 }),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  sku: varchar("sku", { length: 64 }),
  cost_amount: integer("cost_amount"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Customers ───────────────────────────────────────────────────────────────
// business_id added nullable in Batch 1 (DA-4). Backfill and query migration
// from user_uid to business_id happens in Batch 2 once active business
// context is wired through the request lifecycle.
export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  phone: varchar("phone", { length: 20 }),
  user_uid: varchar("user_uid", { length: 255 }).notNull(),
  business_id: integer("business_id").references(() => businesses.id),
  status: varchar("status", { length: 20 }),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Orders ──────────────────────────────────────────────────────────────────
// Batch 4: orders gain business/location/cash_session scoping plus split
// payment_status (financial) vs process_status (operational) and the void
// trail (voidance_reason / voided_at / voided_by_user_id). The legacy
// `status` column is kept for back-compat with dashboard/transactions
// queries that still read it; new code uses `process_status` as the
// source of truth. Allowed payment_status (zod): paid, unpaid,
// partially_paid. Allowed process_status (zod): pending, ongoing,
// complete, void.
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  customer_id: integer("customer_id").references(() => customers.id),
  total_amount: integer("total_amount").notNull(),
  user_uid: varchar("user_uid", { length: 255 }).notNull(),
  status: varchar("status", { length: 20 }),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  cash_session_id: integer("cash_session_id")
    .notNull()
    .references(() => cashSessions.id),
  payment_status: varchar("payment_status", { length: 20 })
    .notNull()
    .default("unpaid"),
  process_status: varchar("process_status", { length: 20 })
    .notNull()
    .default("complete"),
  voidance_reason: text("voidance_reason"),
  voided_at: timestamp("voided_at"),
  voided_by_user_id: text("voided_by_user_id").references(() => user.id),
  notes: text("notes"),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Order Items ─────────────────────────────────────────────────────────────
// Batch 4 adds snapshot columns (product_name, unit_price, unit_cost,
// total_price) populated at sale time so price/name changes after the
// sale never alter the order_item row. They are nullable for legacy
// rows that pre-date Batch 4 (no demo orders pre-migrate); new inserts
// always populate them. The legacy `price` column stays for back-compat.
export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  order_id: integer("order_id").references(() => orders.id),
  product_id: integer("product_id").references(() => products.id),
  quantity: integer("quantity").notNull(),
  price: integer("price").notNull(),
  product_name: varchar("product_name", { length: 255 }),
  unit_price: integer("unit_price"),
  unit_cost: integer("unit_cost"),
  total_price: integer("total_price"),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Payment Methods ─────────────────────────────────────────────────────────
// business_id added nullable in Batch 1 (DA-5). Methods with NULL business_id
// are global (cash, generic transfer); methods with business_id belong to
// that business only. UI filter: WHERE business_id IS NULL OR business_id = :id.
export const paymentMethods = pgTable("payment_methods", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).notNull().unique(),
  business_id: integer("business_id").references(() => businesses.id),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Transactions ────────────────────────────────────────────────────────────
export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  description: text("description"),
  order_id: integer("order_id").references(() => orders.id),
  payment_method_id: integer("payment_method_id").references(() => paymentMethods.id),
  amount: integer("amount").notNull(),
  user_uid: varchar("user_uid", { length: 255 }).notNull(),
  type: varchar("type", { length: 20 }),
  category: varchar("category", { length: 100 }),
  status: varchar("status", { length: 20 }),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Order Payments ──────────────────────────────────────────────────────────
// Batch 4: 1:N from orders. Multi-payment supported from day 1 (pattern
// inspired by NexoPOS nexopos_orders_payments). Every payment row references
// the cash_session in effect when the payment was registered — even digital
// payments — so cash session close/reconciliation has full audit context.
export const orderPayments = pgTable("order_payments", {
  id: serial("id").primaryKey(),
  order_id: integer("order_id")
    .notNull()
    .references(() => orders.id),
  payment_method_id: integer("payment_method_id")
    .notNull()
    .references(() => paymentMethods.id),
  cash_session_id: integer("cash_session_id")
    .notNull()
    .references(() => cashSessions.id),
  amount: integer("amount").notNull(),
  created_by_user_id: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Relations ───────────────────────────────────────────────────────────────
export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, {
    fields: [orders.customer_id],
    references: [customers.id],
  }),
  business: one(businesses, {
    fields: [orders.business_id],
    references: [businesses.id],
  }),
  location: one(locations, {
    fields: [orders.location_id],
    references: [locations.id],
  }),
  cashSession: one(cashSessions, {
    fields: [orders.cash_session_id],
    references: [cashSessions.id],
  }),
  voidedBy: one(user, {
    fields: [orders.voided_by_user_id],
    references: [user.id],
  }),
  orderItems: many(orderItems),
  payments: many(orderPayments),
}));

export const orderPaymentsRelations = relations(orderPayments, ({ one }) => ({
  order: one(orders, {
    fields: [orderPayments.order_id],
    references: [orders.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [orderPayments.payment_method_id],
    references: [paymentMethods.id],
  }),
  cashSession: one(cashSessions, {
    fields: [orderPayments.cash_session_id],
    references: [cashSessions.id],
  }),
  createdBy: one(user, {
    fields: [orderPayments.created_by_user_id],
    references: [user.id],
  }),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.order_id],
    references: [orders.id],
  }),
  product: one(products, {
    fields: [orderItems.product_id],
    references: [products.id],
  }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  order: one(orders, {
    fields: [transactions.order_id],
    references: [orders.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [transactions.payment_method_id],
    references: [paymentMethods.id],
  }),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  orders: many(orders),
}));

export const productsRelations = relations(products, ({ many }) => ({
  orderItems: many(orderItems),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({ one, many }) => ({
  transactions: many(transactions),
  business: one(businesses, {
    fields: [paymentMethods.business_id],
    references: [businesses.id],
  }),
}));

// ── Business / Membership / Location Relations ──────────────────────────────
export const businessesRelations = relations(businesses, ({ many }) => ({
  members: many(businessMembers),
  locations: many(locations),
}));

export const businessMembersRelations = relations(businessMembers, ({ one }) => ({
  business: one(businesses, {
    fields: [businessMembers.business_id],
    references: [businesses.id],
  }),
  user: one(user, {
    fields: [businessMembers.user_id],
    references: [user.id],
  }),
}));

export const locationsRelations = relations(locations, ({ one }) => ({
  business: one(businesses, {
    fields: [locations.business_id],
    references: [businesses.id],
  }),
}));

// ── Cash Sessions ───────────────────────────────────────────────────────────
// One open session per (business, location). status allowed values: open,
// closed (enforced at zod layer, no DB CHECK to keep tableToDDL helper simple).
// Amounts in minor currency units (integer). expected_cash_amount is updated
// as cash sales/refunds/manual movements happen; counted_cash_amount is set
// at close time and difference_amount = counted - expected.
export const cashSessions = pgTable("cash_sessions", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  opened_by_user_id: text("opened_by_user_id")
    .notNull()
    .references(() => user.id),
  closed_by_user_id: text("closed_by_user_id").references(() => user.id),
  opening_cash_amount: integer("opening_cash_amount").notNull().default(0),
  expected_cash_amount: integer("expected_cash_amount").notNull().default(0),
  counted_cash_amount: integer("counted_cash_amount"),
  expected_digital_amount: integer("expected_digital_amount").notNull().default(0),
  difference_amount: integer("difference_amount"),
  status: varchar("status", { length: 20 }).notNull().default("open"),
  opened_at: timestamp("opened_at").defaultNow(),
  closed_at: timestamp("closed_at"),
  notes: text("notes"),
});

// ── Cash Movements ──────────────────────────────────────────────────────────
// Running-balance ledger for the cash drawer (Ajuste 1, pattern inspired by
// NexoPOS nexopos_registers_history). Each row stores balance_before and
// balance_after so the current cash balance is an O(1) read of the latest
// row for a session. amount is signed: positive = money in, negative = out.
// type allowed values: sale, refund, manual_in, manual_out, adjustment.
// transaction_type allowed: positive, negative, unchanged. Both enforced
// at the zod layer in routers, no DB CHECK.
export const cashMovements = pgTable("cash_movements", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  cash_session_id: integer("cash_session_id")
    .notNull()
    .references(() => cashSessions.id),
  type: varchar("type", { length: 20 }).notNull(),
  payment_method_id: integer("payment_method_id").references(() => paymentMethods.id),
  source_type: varchar("source_type", { length: 50 }),
  source_id: integer("source_id"),
  amount: integer("amount").notNull(),
  balance_before: integer("balance_before").notNull(),
  balance_after: integer("balance_after").notNull(),
  transaction_type: varchar("transaction_type", { length: 20 }).notNull(),
  created_by_user_id: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  notes: text("notes"),
  created_at: timestamp("created_at").defaultNow(),
});

export const cashSessionsRelations = relations(cashSessions, ({ one, many }) => ({
  business: one(businesses, {
    fields: [cashSessions.business_id],
    references: [businesses.id],
  }),
  location: one(locations, {
    fields: [cashSessions.location_id],
    references: [locations.id],
  }),
  openedBy: one(user, {
    fields: [cashSessions.opened_by_user_id],
    references: [user.id],
    relationName: "cashSessionOpenedBy",
  }),
  closedBy: one(user, {
    fields: [cashSessions.closed_by_user_id],
    references: [user.id],
    relationName: "cashSessionClosedBy",
  }),
  movements: many(cashMovements),
}));

export const cashMovementsRelations = relations(cashMovements, ({ one }) => ({
  business: one(businesses, {
    fields: [cashMovements.business_id],
    references: [businesses.id],
  }),
  location: one(locations, {
    fields: [cashMovements.location_id],
    references: [locations.id],
  }),
  cashSession: one(cashSessions, {
    fields: [cashMovements.cash_session_id],
    references: [cashSessions.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [cashMovements.payment_method_id],
    references: [paymentMethods.id],
  }),
  createdBy: one(user, {
    fields: [cashMovements.created_by_user_id],
    references: [user.id],
  }),
}));

// ── Inventory Balances ──────────────────────────────────────────────────────
// On-hand stock per (business, location, product). Logical uniqueness on
// (business_id, location_id, product_id) is enforced at the router layer
// because helpers.ts:tableToDDL does not emit compound UNIQUE constraints.
// quantity_reserved stays 0 throughout Batch 3 — reservations land in a
// future batch when PostgreSQL real (not PGlite) is wired in.
export const inventoryBalances = pgTable("inventory_balances", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  product_id: integer("product_id")
    .notNull()
    .references(() => products.id),
  quantity_on_hand: integer("quantity_on_hand").notNull().default(0),
  quantity_reserved: integer("quantity_reserved").notNull().default(0),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ── Inventory Movements (ledger) ────────────────────────────────────────────
// Append-only ledger for stock changes. quantity_delta is signed: positive
// = in, negative = out. type allowed values (enforced via zod at router
// layer): adjustment, transfer_in, transfer_out, initial_import,
// internal_consumption. The varchar(30) length also accommodates future
// values reserved for Batch 4/6: sale, refund, purchase.
export const inventoryMovements = pgTable("inventory_movements", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  product_id: integer("product_id")
    .notNull()
    .references(() => products.id),
  quantity_delta: integer("quantity_delta").notNull(),
  type: varchar("type", { length: 30 }).notNull(),
  source_type: varchar("source_type", { length: 50 }),
  source_id: integer("source_id"),
  created_by_user_id: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  notes: text("notes"),
  created_at: timestamp("created_at").defaultNow(),
});

export const inventoryBalancesRelations = relations(
  inventoryBalances,
  ({ one }) => ({
    business: one(businesses, {
      fields: [inventoryBalances.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [inventoryBalances.location_id],
      references: [locations.id],
    }),
    product: one(products, {
      fields: [inventoryBalances.product_id],
      references: [products.id],
    }),
  }),
);

export const inventoryMovementsRelations = relations(
  inventoryMovements,
  ({ one }) => ({
    business: one(businesses, {
      fields: [inventoryMovements.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [inventoryMovements.location_id],
      references: [locations.id],
    }),
    product: one(products, {
      fields: [inventoryMovements.product_id],
      references: [products.id],
    }),
    createdBy: one(user, {
      fields: [inventoryMovements.created_by_user_id],
      references: [user.id],
    }),
  }),
);

// ── Expense Categories (Batch 6) ────────────────────────────────────────────
// Pattern inspired by NexoPOS nexopos_expenses_categories. Distinct from
// procurements/inventory purchases — operational P&L only. Allowed kind
// values (informational, no semantics in MVP, enforced at zod): operational,
// recurring, one_off.
export const expenseCategories = pgTable("expense_categories", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  name: varchar("name", { length: 100 }).notNull(),
  kind: varchar("kind", { length: 20 }).notNull().default("operational"),
  archived: boolean("archived").notNull().default(false),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Expense Entries (Batch 6) ───────────────────────────────────────────────
// One row per registered expense. location_id nullable for business-wide
// expenses (accounting, central marketing). cash_session_id is set when the
// expense is paid out of an open session so cash close has full audit
// context (mirrors order_payments pattern).
export const expenseEntries = pgTable("expense_entries", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id").references(() => locations.id),
  category_id: integer("category_id")
    .notNull()
    .references(() => expenseCategories.id),
  amount: integer("amount").notNull(),
  payment_method_id: integer("payment_method_id").references(
    () => paymentMethods.id,
  ),
  cash_session_id: integer("cash_session_id").references(() => cashSessions.id),
  description: text("description"),
  incurred_at: timestamp("incurred_at").notNull(),
  created_by_user_id: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Suppliers (Batch 6) ─────────────────────────────────────────────────────
export const suppliers = pgTable("suppliers", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  name: varchar("name", { length: 255 }).notNull(),
  contact_email: varchar("contact_email", { length: 255 }),
  contact_phone: varchar("contact_phone", { length: 50 }),
  notes: text("notes"),
  archived: boolean("archived").notNull().default(false),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Purchase Orders (Batch 6) ───────────────────────────────────────────────
// Procurements ledger. Strictly separate from expense_entries: a purchase
// adds inventory + may move cash; an expense only moves cash. Allowed
// status values (enforced in zod): draft, received, cancelled.
export const purchaseOrders = pgTable("purchase_orders", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  supplier_id: integer("supplier_id").references(() => suppliers.id),
  status: varchar("status", { length: 20 }).notNull().default("draft"),
  total_amount: integer("total_amount").notNull().default(0),
  payment_method_id: integer("payment_method_id").references(
    () => paymentMethods.id,
  ),
  cash_session_id: integer("cash_session_id").references(() => cashSessions.id),
  notes: text("notes"),
  created_by_user_id: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  created_at: timestamp("created_at").defaultNow(),
  received_at: timestamp("received_at"),
});

// ── Purchase Items (Batch 6) ────────────────────────────────────────────────
export const purchaseItems = pgTable("purchase_items", {
  id: serial("id").primaryKey(),
  purchase_order_id: integer("purchase_order_id")
    .notNull()
    .references(() => purchaseOrders.id),
  product_id: integer("product_id")
    .notNull()
    .references(() => products.id),
  quantity: integer("quantity").notNull(),
  unit_cost: integer("unit_cost").notNull(),
  total_cost: integer("total_cost").notNull(),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Batch 6 Relations ───────────────────────────────────────────────────────
export const expenseCategoriesRelations = relations(
  expenseCategories,
  ({ one, many }) => ({
    business: one(businesses, {
      fields: [expenseCategories.business_id],
      references: [businesses.id],
    }),
    entries: many(expenseEntries),
  }),
);

export const expenseEntriesRelations = relations(expenseEntries, ({ one }) => ({
  business: one(businesses, {
    fields: [expenseEntries.business_id],
    references: [businesses.id],
  }),
  location: one(locations, {
    fields: [expenseEntries.location_id],
    references: [locations.id],
  }),
  category: one(expenseCategories, {
    fields: [expenseEntries.category_id],
    references: [expenseCategories.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [expenseEntries.payment_method_id],
    references: [paymentMethods.id],
  }),
  cashSession: one(cashSessions, {
    fields: [expenseEntries.cash_session_id],
    references: [cashSessions.id],
  }),
  createdBy: one(user, {
    fields: [expenseEntries.created_by_user_id],
    references: [user.id],
  }),
}));

export const suppliersRelations = relations(suppliers, ({ one, many }) => ({
  business: one(businesses, {
    fields: [suppliers.business_id],
    references: [businesses.id],
  }),
  purchaseOrders: many(purchaseOrders),
}));

export const purchaseOrdersRelations = relations(
  purchaseOrders,
  ({ one, many }) => ({
    business: one(businesses, {
      fields: [purchaseOrders.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [purchaseOrders.location_id],
      references: [locations.id],
    }),
    supplier: one(suppliers, {
      fields: [purchaseOrders.supplier_id],
      references: [suppliers.id],
    }),
    paymentMethod: one(paymentMethods, {
      fields: [purchaseOrders.payment_method_id],
      references: [paymentMethods.id],
    }),
    cashSession: one(cashSessions, {
      fields: [purchaseOrders.cash_session_id],
      references: [cashSessions.id],
    }),
    createdBy: one(user, {
      fields: [purchaseOrders.created_by_user_id],
      references: [user.id],
    }),
    items: many(purchaseItems),
  }),
);

export const purchaseItemsRelations = relations(purchaseItems, ({ one }) => ({
  purchaseOrder: one(purchaseOrders, {
    fields: [purchaseItems.purchase_order_id],
    references: [purchaseOrders.id],
  }),
  product: one(products, {
    fields: [purchaseItems.product_id],
    references: [products.id],
  }),
}));
