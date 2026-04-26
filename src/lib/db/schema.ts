import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  timestamp,
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
export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  price: integer("price").notNull(),
  in_stock: integer("in_stock").notNull(),
  user_uid: varchar("user_uid", { length: 255 }).notNull(),
  category: varchar("category", { length: 50 }),
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
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  customer_id: integer("customer_id").references(() => customers.id),
  total_amount: integer("total_amount").notNull(),
  user_uid: varchar("user_uid", { length: 255 }).notNull(),
  status: varchar("status", { length: 20 }),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Order Items ─────────────────────────────────────────────────────────────
export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  order_id: integer("order_id").references(() => orders.id),
  product_id: integer("product_id").references(() => products.id),
  quantity: integer("quantity").notNull(),
  price: integer("price").notNull(),
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

// ── Relations ───────────────────────────────────────────────────────────────
export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, {
    fields: [orders.customer_id],
    references: [customers.id],
  }),
  orderItems: many(orderItems),
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
