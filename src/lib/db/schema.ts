import {
  pgTable,
  serial,
  varchar,
  text,
  integer,
  timestamp,
  boolean,
  index,
  uniqueIndex,
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
// `kind` separates physical inventory items from intangible services
// (tattoo/piercing/etc). Allowed values (enforced in zod): product, service.
// `default_service_kind` is only relevant when kind="service" and prefills the
// service_sales.service_kind column on attach. Allowed values (enforced in
// zod, mirrors service_sales.service_kind): tattoo, piercing, touchup,
// removal, consultation, other.
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
  image_url: text("image_url"),
  image_urls_json: text("image_urls_json"),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  kind: varchar("kind", { length: 20 }).notNull().default("product"),
  default_service_kind: varchar("default_service_kind", { length: 30 }),
  created_at: timestamp("created_at").defaultNow(),
});

export const productCategories = pgTable(
  "product_categories",
  {
    id: serial("id").primaryKey(),
    business_id: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    name: varchar("name", { length: 50 }).notNull(),
    created_at: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("product_categories_business_idx").on(table.business_id),
    uniqueIndex("product_categories_business_name_uidx").on(
      table.business_id,
      table.name,
    ),
  ],
);

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
// trail (voidance_reason / voided_at / voided_by_user_id). `process_status`
// is the operational source of truth. Allowed payment_status (zod): paid,
// unpaid, partially_paid. Allowed process_status (zod): pending, ongoing,
// complete, void.
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  customer_id: integer("customer_id").references(() => customers.id),
  total_amount: integer("total_amount").notNull(),
  user_uid: varchar("user_uid", { length: 255 }).notNull(),
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

// ── Service Agreements (Fase 1) ─────────────────────────────────────────────
// Commercial entity for tattoo/piercing projects with agreed total and partial
// payments over time. Amount fields are in minor currency units (COP cents-like
// integer strategy already used across the app).
export const serviceAgreements = pgTable("service_agreements", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  customer_id: integer("customer_id").references(() => customers.id),
  created_by_user_id: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  service_name: varchar("service_name", { length: 255 }).notNull(),
  total_agreed_amount: integer("total_agreed_amount").notNull(),
  total_paid_amount: integer("total_paid_amount").notNull().default(0),
  pending_amount: integer("pending_amount").notNull(),
  default_commission_rate_bps: integer("default_commission_rate_bps")
    .notNull()
    .default(3000),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  notes: text("notes"),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

// ── Bookings (Agendamientos - Fase 1) ───────────────────────────────────────
export const bookings = pgTable(
  "bookings",
  {
    id: serial("id").primaryKey(),
    business_id: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    location_id: integer("location_id")
      .notNull()
      .references(() => locations.id),
    customer_id: integer("customer_id").references(() => customers.id),
    staff_id: integer("staff_id").references(() => staffMembers.id),
    service_kind: varchar("service_kind", { length: 20 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    notes: text("notes"),
    starts_at: timestamp("starts_at").notNull(),
    ends_at: timestamp("ends_at").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"),
    confirmation_status: varchar("confirmation_status", { length: 20 })
      .notNull()
      .default("pending"),
    service_agreement_id: integer("service_agreement_id").references(
      () => serviceAgreements.id,
    ),
    created_at: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("bookings_business_idx").on(table.business_id),
    index("bookings_location_idx").on(table.location_id),
    index("bookings_starts_at_idx").on(table.starts_at),
    index("bookings_staff_idx").on(table.staff_id),
  ],
);

export const bookingEvents = pgTable(
  "booking_events",
  {
    id: serial("id").primaryKey(),
    booking_id: integer("booking_id")
      .notNull()
      .references(() => bookings.id),
    business_id: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    event_type: varchar("event_type", { length: 50 }).notNull(),
    payload_json: text("payload_json").notNull(),
    actor_user_id: text("actor_user_id").references(() => user.id),
    created_at: timestamp("created_at").defaultNow(),
  },
  (table) => [
    index("booking_events_booking_idx").on(table.booking_id),
    index("booking_events_business_idx").on(table.business_id),
    index("booking_events_created_at_idx").on(table.created_at),
  ],
);

export const serviceAgreementSessions = pgTable("service_agreement_sessions", {
  id: serial("id").primaryKey(),
  service_agreement_id: integer("service_agreement_id")
    .notNull()
    .references(() => serviceAgreements.id),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  staff_member_id: integer("staff_member_id")
    .notNull()
    .references(() => staffMembers.id),
  scheduled_for: timestamp("scheduled_for").notNull(),
  session_amount: integer("session_amount").notNull().default(0),
  commission_rate_bps: integer("commission_rate_bps").notNull().default(3000),
  status: varchar("status", { length: 20 }).notNull().default("scheduled"),
  notes: text("notes"),
  created_by_user_id: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const serviceAgreementCommissions = pgTable(
  "service_agreement_commissions",
  {
    id: serial("id").primaryKey(),
    service_agreement_id: integer("service_agreement_id")
      .notNull()
      .references(() => serviceAgreements.id),
    service_agreement_session_id: integer("service_agreement_session_id")
      .notNull()
      .references(() => serviceAgreementSessions.id),
    business_id: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    location_id: integer("location_id")
      .notNull()
      .references(() => locations.id),
    staff_member_id: integer("staff_member_id")
      .notNull()
      .references(() => staffMembers.id),
    commission_base_amount: integer("commission_base_amount").notNull(),
    commission_rate_bps: integer("commission_rate_bps").notNull(),
    commission_amount: integer("commission_amount").notNull(),
    status: varchar("status", { length: 20 }).notNull().default("estimated"),
    notes: text("notes"),
    calculated_by_user_id: text("calculated_by_user_id")
      .notNull()
      .references(() => user.id),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
);

export const serviceAgreementConsumptionTemplates = pgTable(
  "service_agreement_consumption_templates",
  {
    id: serial("id").primaryKey(),
    service_agreement_id: integer("service_agreement_id")
      .notNull()
      .references(() => serviceAgreements.id),
    business_id: integer("business_id")
      .notNull()
      .references(() => businesses.id),
    location_id: integer("location_id")
      .notNull()
      .references(() => locations.id),
    product_id: integer("product_id")
      .notNull()
      .references(() => products.id),
    quantity_per_session: integer("quantity_per_session").notNull(),
    created_by_user_id: text("created_by_user_id")
      .notNull()
      .references(() => user.id),
    created_at: timestamp("created_at").defaultNow(),
    updated_at: timestamp("updated_at").defaultNow(),
  },
);

export const serviceAgreementPayments = pgTable("service_agreement_payments", {
  id: serial("id").primaryKey(),
  service_agreement_id: integer("service_agreement_id")
    .notNull()
    .references(() => serviceAgreements.id),
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
  notes: text("notes"),
  created_at: timestamp("created_at").defaultNow(),
});

export const serviceAgreementMedia = pgTable("service_agreement_media", {
  id: serial("id").primaryKey(),
  service_agreement_id: integer("service_agreement_id").references(
    () => serviceAgreements.id,
  ),
  service_agreement_session_id: integer("service_agreement_session_id").references(
    () => serviceAgreementSessions.id,
  ),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  media_url: text("media_url").notNull(),
  media_kind: varchar("media_kind", { length: 20 }).notNull().default("reference"),
  mime_type: varchar("mime_type", { length: 100 }),
  size_bytes: integer("size_bytes"),
  caption: text("caption"),
  created_by_user_id: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  created_at: timestamp("created_at").defaultNow(),
});

export const customerMessageConsents = pgTable("customer_message_consents", {
  id: serial("id").primaryKey(),
  customer_id: integer("customer_id")
    .notNull()
    .references(() => customers.id),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id").references(() => locations.id),
  channel: varchar("channel", { length: 20 }).notNull().default("whatsapp"),
  status: varchar("status", { length: 20 }).notNull().default("granted"),
  source: varchar("source", { length: 50 }),
  notes: text("notes"),
  granted_at: timestamp("granted_at"),
  revoked_at: timestamp("revoked_at"),
  created_by_user_id: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

export const followUpOutboxEvents = pgTable("follow_up_outbox_events", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id").references(() => locations.id),
  customer_id: integer("customer_id").references(() => customers.id),
  service_agreement_id: integer("service_agreement_id").references(
    () => serviceAgreements.id,
  ),
  service_agreement_session_id: integer("service_agreement_session_id").references(
    () => serviceAgreementSessions.id,
  ),
  booking_id: integer("booking_id").references(() => bookings.id),
  event_type: varchar("event_type", { length: 50 }).notNull(),
  idempotency_key: varchar("idempotency_key", { length: 191 }),
  payload_json: text("payload_json").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  next_attempt_at: timestamp("next_attempt_at"),
  dispatched_at: timestamp("dispatched_at"),
  last_error: text("last_error"),
  created_by_user_id: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("follow_up_outbox_events_idempotency_uidx").on(table.idempotency_key),
]);

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

export const serviceAgreementsRelations = relations(
  serviceAgreements,
  ({ one, many }) => ({
    business: one(businesses, {
      fields: [serviceAgreements.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [serviceAgreements.location_id],
      references: [locations.id],
    }),
    customer: one(customers, {
      fields: [serviceAgreements.customer_id],
      references: [customers.id],
    }),
    createdBy: one(user, {
      fields: [serviceAgreements.created_by_user_id],
      references: [user.id],
    }),
    payments: many(serviceAgreementPayments),
    sessions: many(serviceAgreementSessions),
    commissions: many(serviceAgreementCommissions),
    consumptionTemplates: many(serviceAgreementConsumptionTemplates),
  }),
);

export const serviceAgreementSessionsRelations = relations(
  serviceAgreementSessions,
  ({ one, many }) => ({
    agreement: one(serviceAgreements, {
      fields: [serviceAgreementSessions.service_agreement_id],
      references: [serviceAgreements.id],
    }),
    business: one(businesses, {
      fields: [serviceAgreementSessions.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [serviceAgreementSessions.location_id],
      references: [locations.id],
    }),
    staffMember: one(staffMembers, {
      fields: [serviceAgreementSessions.staff_member_id],
      references: [staffMembers.id],
    }),
    createdBy: one(user, {
      fields: [serviceAgreementSessions.created_by_user_id],
      references: [user.id],
    }),
    commissions: many(serviceAgreementCommissions),
  }),
);

export const serviceAgreementCommissionsRelations = relations(
  serviceAgreementCommissions,
  ({ one }) => ({
    agreement: one(serviceAgreements, {
      fields: [serviceAgreementCommissions.service_agreement_id],
      references: [serviceAgreements.id],
    }),
    session: one(serviceAgreementSessions, {
      fields: [serviceAgreementCommissions.service_agreement_session_id],
      references: [serviceAgreementSessions.id],
    }),
    business: one(businesses, {
      fields: [serviceAgreementCommissions.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [serviceAgreementCommissions.location_id],
      references: [locations.id],
    }),
    staffMember: one(staffMembers, {
      fields: [serviceAgreementCommissions.staff_member_id],
      references: [staffMembers.id],
    }),
    calculatedBy: one(user, {
      fields: [serviceAgreementCommissions.calculated_by_user_id],
      references: [user.id],
    }),
  }),
);

export const serviceAgreementConsumptionTemplatesRelations = relations(
  serviceAgreementConsumptionTemplates,
  ({ one }) => ({
    agreement: one(serviceAgreements, {
      fields: [serviceAgreementConsumptionTemplates.service_agreement_id],
      references: [serviceAgreements.id],
    }),
    business: one(businesses, {
      fields: [serviceAgreementConsumptionTemplates.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [serviceAgreementConsumptionTemplates.location_id],
      references: [locations.id],
    }),
    product: one(products, {
      fields: [serviceAgreementConsumptionTemplates.product_id],
      references: [products.id],
    }),
    createdBy: one(user, {
      fields: [serviceAgreementConsumptionTemplates.created_by_user_id],
      references: [user.id],
    }),
  }),
);

export const serviceAgreementPaymentsRelations = relations(
  serviceAgreementPayments,
  ({ one }) => ({
    agreement: one(serviceAgreements, {
      fields: [serviceAgreementPayments.service_agreement_id],
      references: [serviceAgreements.id],
    }),
    order: one(orders, {
      fields: [serviceAgreementPayments.order_id],
      references: [orders.id],
    }),
    paymentMethod: one(paymentMethods, {
      fields: [serviceAgreementPayments.payment_method_id],
      references: [paymentMethods.id],
    }),
    cashSession: one(cashSessions, {
      fields: [serviceAgreementPayments.cash_session_id],
      references: [cashSessions.id],
    }),
    createdBy: one(user, {
      fields: [serviceAgreementPayments.created_by_user_id],
      references: [user.id],
    }),
  }),
);

export const serviceAgreementMediaRelations = relations(
  serviceAgreementMedia,
  ({ one }) => ({
    agreement: one(serviceAgreements, {
      fields: [serviceAgreementMedia.service_agreement_id],
      references: [serviceAgreements.id],
    }),
    session: one(serviceAgreementSessions, {
      fields: [serviceAgreementMedia.service_agreement_session_id],
      references: [serviceAgreementSessions.id],
    }),
    business: one(businesses, {
      fields: [serviceAgreementMedia.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [serviceAgreementMedia.location_id],
      references: [locations.id],
    }),
    createdBy: one(user, {
      fields: [serviceAgreementMedia.created_by_user_id],
      references: [user.id],
    }),
  }),
);

export const customerMessageConsentsRelations = relations(
  customerMessageConsents,
  ({ one }) => ({
    customer: one(customers, {
      fields: [customerMessageConsents.customer_id],
      references: [customers.id],
    }),
    business: one(businesses, {
      fields: [customerMessageConsents.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [customerMessageConsents.location_id],
      references: [locations.id],
    }),
    createdBy: one(user, {
      fields: [customerMessageConsents.created_by_user_id],
      references: [user.id],
    }),
  }),
);

export const followUpOutboxEventsRelations = relations(
  followUpOutboxEvents,
  ({ one }) => ({
    business: one(businesses, {
      fields: [followUpOutboxEvents.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [followUpOutboxEvents.location_id],
      references: [locations.id],
    }),
    customer: one(customers, {
      fields: [followUpOutboxEvents.customer_id],
      references: [customers.id],
    }),
    agreement: one(serviceAgreements, {
      fields: [followUpOutboxEvents.service_agreement_id],
      references: [serviceAgreements.id],
    }),
    session: one(serviceAgreementSessions, {
      fields: [followUpOutboxEvents.service_agreement_session_id],
      references: [serviceAgreementSessions.id],
    }),
    booking: one(bookings, {
      fields: [followUpOutboxEvents.booking_id],
      references: [bookings.id],
    }),
    createdBy: one(user, {
      fields: [followUpOutboxEvents.created_by_user_id],
      references: [user.id],
    }),
  }),
);

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

export const customersRelations = relations(customers, ({ many }) => ({
  orders: many(orders),
}));

export const productsRelations = relations(products, ({ many }) => ({
  orderItems: many(orderItems),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({ one }) => ({
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

// ── Staff Members (Batch 8) ─────────────────────────────────────────────────
// People who PERFORM services. May or may not coincide with business_members
// (the auth-level membership): some staff are external artists with no app
// login. Allowed kind values (enforced at zod): artist, apprentice, piercer,
// manager, external. Allowed default_split values: staff_30_house_70,
// staff_50_house_50, staff_70_house_30, owner_direct, manual.
// commission_rate stored as basis points (3000 = 30%).
export const staffMembers = pgTable("staff_members", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  user_id: text("user_id").references(() => user.id),
  display_name: varchar("display_name", { length: 255 }).notNull(),
  kind: varchar("kind", { length: 20 }).notNull().default("artist"),
  commission_rate: integer("commission_rate").notNull().default(0),
  default_split: varchar("default_split", { length: 20 })
    .notNull()
    .default("staff_30_house_70"),
  archived: boolean("archived").notNull().default(false),
  notes: text("notes"),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Workstations (Batch 8) ──────────────────────────────────────────────────
// Physical stations at a location (a tattoo bed, a piercing chair). Used by
// station_rentals. Allowed kind values: tattoo, piercing, general
// (informational, enforced at zod).
export const workstations = pgTable("workstations", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  name: varchar("name", { length: 100 }).notNull(),
  kind: varchar("kind", { length: 20 }).notNull().default("tattoo"),
  archived: boolean("archived").notNull().default(false),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Station Rentals (Batch 8) ───────────────────────────────────────────────
// External artists renting a station for a session/day. Generates revenue
// (positive cash when paid via POS lifecycle) but is NOT a service sale.
// Allowed status values (enforced at zod): scheduled, completed, cancelled.
export const stationRentals = pgTable("station_rentals", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  workstation_id: integer("workstation_id")
    .notNull()
    .references(() => workstations.id),
  staff_member_id: integer("staff_member_id")
    .notNull()
    .references(() => staffMembers.id),
  cash_session_id: integer("cash_session_id").references(() => cashSessions.id),
  payment_method_id: integer("payment_method_id").references(
    () => paymentMethods.id,
  ),
  amount: integer("amount").notNull(),
  start_at: timestamp("start_at").notNull(),
  end_at: timestamp("end_at").notNull(),
  status: varchar("status", { length: 20 }).notNull().default("scheduled"),
  notes: text("notes"),
  created_by_user_id: text("created_by_user_id")
    .notNull()
    .references(() => user.id),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Service Sales (Batch 8) ─────────────────────────────────────────────────
// Joins an order_item with the staff_member who performed the service. One
// row per order_item that represents a service (tattoo/piercing/etc).
// Allowed service_kind values (enforced at zod, adopted from studio-crm):
// tattoo, piercing, touchup, removal, consultation, other. commission_split
// is a snapshot of staff.default_split at sale time.
export const serviceSales = pgTable("service_sales", {
  id: serial("id").primaryKey(),
  order_item_id: integer("order_item_id")
    .notNull()
    .references(() => orderItems.id),
  staff_member_id: integer("staff_member_id")
    .notNull()
    .references(() => staffMembers.id),
  service_kind: varchar("service_kind", { length: 30 }).notNull(),
  body_location: varchar("body_location", { length: 100 }),
  materials_used: text("materials_used"),
  practitioner_notes: text("practitioner_notes"),
  commission_split: varchar("commission_split", { length: 20 }).notNull(),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Commission Estimates (Batch 8) ──────────────────────────────────────────
// Estimated commission per service_sale, computed at sale time but flagged as
// `estimated` until manual liquidation. NEVER auto-generates a payout — Jeff
// liquidates manually. Allowed status values (enforced at zod): estimated,
// manual_pending, liquidated, voided. business_id is denormalized for reports.
export const commissionEstimates = pgTable("commission_estimates", {
  id: serial("id").primaryKey(),
  service_sale_id: integer("service_sale_id")
    .notNull()
    .references(() => serviceSales.id),
  staff_member_id: integer("staff_member_id")
    .notNull()
    .references(() => staffMembers.id),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  gross_amount: integer("gross_amount").notNull(),
  staff_share_amount: integer("staff_share_amount").notNull(),
  house_share_amount: integer("house_share_amount").notNull(),
  split_kind: varchar("split_kind", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("estimated"),
  liquidated_at: timestamp("liquidated_at"),
  liquidated_by_user_id: text("liquidated_by_user_id").references(
    () => user.id,
  ),
  notes: text("notes"),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Location Members (Batch 8) ──────────────────────────────────────────────
// Granular per-location permission for staff who only operate at one sede.
// Coexists with business_members (broader business-level membership). A user
// can be business_members.role=cashier AND location_members.role=artist at
// Amparo only. Allowed role values (enforced at zod): cashier, artist,
// manager, viewer. Allowed status: active, suspended, removed.
// resolveActiveContext intentionally still reads only business_members in
// Batch 8; granular per-location auth is a future refinement.
export const locationMembers = pgTable("location_members", {
  id: serial("id").primaryKey(),
  business_id: integer("business_id")
    .notNull()
    .references(() => businesses.id),
  location_id: integer("location_id")
    .notNull()
    .references(() => locations.id),
  user_id: text("user_id")
    .notNull()
    .references(() => user.id),
  role: varchar("role", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  created_at: timestamp("created_at").defaultNow(),
});

// ── Batch 8 Relations ───────────────────────────────────────────────────────
export const staffMembersRelations = relations(
  staffMembers,
  ({ one, many }) => ({
    business: one(businesses, {
      fields: [staffMembers.business_id],
      references: [businesses.id],
    }),
    user: one(user, {
      fields: [staffMembers.user_id],
      references: [user.id],
    }),
    serviceSales: many(serviceSales),
    commissionEstimates: many(commissionEstimates),
    stationRentals: many(stationRentals),
    agreementSessions: many(serviceAgreementSessions),
    agreementCommissions: many(serviceAgreementCommissions),
  }),
);

export const workstationsRelations = relations(
  workstations,
  ({ one, many }) => ({
    business: one(businesses, {
      fields: [workstations.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [workstations.location_id],
      references: [locations.id],
    }),
    rentals: many(stationRentals),
  }),
);

export const stationRentalsRelations = relations(stationRentals, ({ one }) => ({
  business: one(businesses, {
    fields: [stationRentals.business_id],
    references: [businesses.id],
  }),
  location: one(locations, {
    fields: [stationRentals.location_id],
    references: [locations.id],
  }),
  workstation: one(workstations, {
    fields: [stationRentals.workstation_id],
    references: [workstations.id],
  }),
  staffMember: one(staffMembers, {
    fields: [stationRentals.staff_member_id],
    references: [staffMembers.id],
  }),
  cashSession: one(cashSessions, {
    fields: [stationRentals.cash_session_id],
    references: [cashSessions.id],
  }),
  paymentMethod: one(paymentMethods, {
    fields: [stationRentals.payment_method_id],
    references: [paymentMethods.id],
  }),
  createdBy: one(user, {
    fields: [stationRentals.created_by_user_id],
    references: [user.id],
  }),
}));

export const serviceSalesRelations = relations(
  serviceSales,
  ({ one, many }) => ({
    orderItem: one(orderItems, {
      fields: [serviceSales.order_item_id],
      references: [orderItems.id],
    }),
    staffMember: one(staffMembers, {
      fields: [serviceSales.staff_member_id],
      references: [staffMembers.id],
    }),
    commissionEstimates: many(commissionEstimates),
  }),
);

export const commissionEstimatesRelations = relations(
  commissionEstimates,
  ({ one }) => ({
    serviceSale: one(serviceSales, {
      fields: [commissionEstimates.service_sale_id],
      references: [serviceSales.id],
    }),
    staffMember: one(staffMembers, {
      fields: [commissionEstimates.staff_member_id],
      references: [staffMembers.id],
    }),
    business: one(businesses, {
      fields: [commissionEstimates.business_id],
      references: [businesses.id],
    }),
    liquidatedBy: one(user, {
      fields: [commissionEstimates.liquidated_by_user_id],
      references: [user.id],
    }),
  }),
);

export const locationMembersRelations = relations(
  locationMembers,
  ({ one }) => ({
    business: one(businesses, {
      fields: [locationMembers.business_id],
      references: [businesses.id],
    }),
    location: one(locations, {
      fields: [locationMembers.location_id],
      references: [locations.id],
    }),
    user: one(user, {
      fields: [locationMembers.user_id],
      references: [user.id],
    }),
  }),
);
