import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { dashboardRouter } = await import("../dashboard");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(dashboardRouter);

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let britaliaId: number;
let otherLocationId: number;
let pinkProductId: number;
let blackProductId: number;
let lowProductId: number;
let otherBizProductId: number;
let pmCashId: number;
let pmTransferId: number;
let amparoOpenSessionId: number;
let britaliaOpenSessionId: number;
let otherLocationSessionId: number;

// Fixed range used by every test: covers all "today" data we seed at
// 2026-01-15 noon. Tests that need to exercise range filtering pass a
// narrower window explicitly.
const RANGE_FROM = new Date("2026-01-15T00:00:00Z");
const RANGE_TO = new Date("2026-01-15T23:59:59Z");
const SALE_AT = new Date("2026-01-15T12:00:00Z");
const OUT_OF_RANGE_AT = new Date("2026-01-10T12:00:00Z");

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff-dash@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-dash@test.com", emailVerified: false, image: null },
    { id: "u-orphan", name: "Orphan", email: "orphan-dash@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-dash" },
      { name: "Other Studio", slug: "other-dash" },
    ])
    .returning();
  bizJeffId = bizJeff.id;
  bizOtherId = bizOther.id;

  await db.insert(schema.businessMembers).values([
    { business_id: bizJeffId, user_id: "u-jeff", role: "owner", status: "active" },
    { business_id: bizOtherId, user_id: "u-other", role: "owner", status: "active" },
  ]);

  const locs = await db
    .insert(schema.locations)
    .values([
      { business_id: bizJeffId, name: "Amparo", slug: "amparo-dash" },
      { business_id: bizJeffId, name: "Britalia", slug: "britalia-dash" },
      { business_id: bizOtherId, name: "Other Location", slug: "other-loc-dash" },
    ])
    .returning();
  amparoId = locs[0].id;
  britaliaId = locs[1].id;
  otherLocationId = locs[2].id;

  const prods = await db
    .insert(schema.products)
    .values([
      { name: "Pink Ink", price: 1_000, in_stock: 0, user_uid: "u-jeff", business_id: bizJeffId, sku: "INK-PINK-D", status: "active" },
      { name: "Black Ink", price: 2_000, in_stock: 0, user_uid: "u-jeff", business_id: bizJeffId, sku: "INK-BLACK-D", status: "active" },
      { name: "Low Stock Item", price: 500, in_stock: 0, user_uid: "u-jeff", business_id: bizJeffId, sku: "LOW-D", status: "active" },
      { name: "Other Biz Item", price: 800, in_stock: 0, user_uid: "u-other", business_id: bizOtherId, sku: "OTHER-D", status: "active" },
    ])
    .returning();
  pinkProductId = prods[0].id;
  blackProductId = prods[1].id;
  lowProductId = prods[2].id;
  otherBizProductId = prods[3].id;

  const pms = await db
    .insert(schema.paymentMethods)
    .values([
      { name: "Cash" },
      { name: "Transfer" },
    ])
    .returning();
  pmCashId = pms[0].id;
  pmTransferId = pms[1].id;

  // Inventory balances: low stock products at <5, others at safe levels.
  await db.insert(schema.inventoryBalances).values([
    { business_id: bizJeffId, location_id: amparoId, product_id: pinkProductId, quantity_on_hand: 50, quantity_reserved: 0 },
    { business_id: bizJeffId, location_id: amparoId, product_id: blackProductId, quantity_on_hand: 50, quantity_reserved: 0 },
    { business_id: bizJeffId, location_id: amparoId, product_id: lowProductId, quantity_on_hand: 2, quantity_reserved: 0 },
    { business_id: bizJeffId, location_id: britaliaId, product_id: pinkProductId, quantity_on_hand: 50, quantity_reserved: 0 },
    { business_id: bizJeffId, location_id: britaliaId, product_id: blackProductId, quantity_on_hand: 1, quantity_reserved: 0 },
    { business_id: bizOtherId, location_id: otherLocationId, product_id: otherBizProductId, quantity_on_hand: 0, quantity_reserved: 0 },
  ]);

  const sessions = await db
    .insert(schema.cashSessions)
    .values([
      {
        business_id: bizJeffId,
        location_id: amparoId,
        opened_by_user_id: "u-jeff",
        opening_cash_amount: 50_000,
        expected_cash_amount: 80_000,
        expected_digital_amount: 30_000,
        status: "open",
      },
      {
        business_id: bizJeffId,
        location_id: britaliaId,
        opened_by_user_id: "u-jeff",
        opening_cash_amount: 30_000,
        expected_cash_amount: 30_000,
        expected_digital_amount: 0,
        status: "open",
      },
      {
        business_id: bizOtherId,
        location_id: otherLocationId,
        opened_by_user_id: "u-other",
        opening_cash_amount: 10_000,
        expected_cash_amount: 10_000,
        expected_digital_amount: 0,
        status: "open",
      },
    ])
    .returning();
  amparoOpenSessionId = sessions[0].id;
  britaliaOpenSessionId = sessions[1].id;
  otherLocationSessionId = sessions[2].id;

  // Orders: insert directly to control created_at and process_status precisely.
  //
  // Amparo (bizJeff):
  //   #A1 complete  10_000  cash 6_000 + transfer 4_000  in-range
  //   #A2 complete   5_000  cash 5_000                   in-range
  //   #A3 void       8_000  cash 8_000                   in-range
  //   #A4 pending    7_000  cash 7_000                   in-range
  //   #A5 complete   3_000  cash 3_000                   OUT-OF-RANGE
  // Britalia (bizJeff):
  //   #B1 complete   2_000  transfer 2_000               in-range
  // Other biz:
  //   #O1 complete  99_000  cash 99_000                  in-range
  const insertedOrders = await db
    .insert(schema.orders)
    .values([
      { customer_id: null, total_amount: 10_000, user_uid: "u-jeff", business_id: bizJeffId, location_id: amparoId, cash_session_id: amparoOpenSessionId, payment_status: "paid", process_status: "complete", created_at: SALE_AT },
      { customer_id: null, total_amount: 5_000, user_uid: "u-jeff", business_id: bizJeffId, location_id: amparoId, cash_session_id: amparoOpenSessionId, payment_status: "paid", process_status: "complete", created_at: SALE_AT },
      { customer_id: null, total_amount: 8_000, user_uid: "u-jeff", business_id: bizJeffId, location_id: amparoId, cash_session_id: amparoOpenSessionId, payment_status: "paid", process_status: "void", voidance_reason: "test", voided_at: SALE_AT, voided_by_user_id: "u-jeff", created_at: SALE_AT },
      { customer_id: null, total_amount: 7_000, user_uid: "u-jeff", business_id: bizJeffId, location_id: amparoId, cash_session_id: amparoOpenSessionId, payment_status: "unpaid", process_status: "pending", created_at: SALE_AT },
      { customer_id: null, total_amount: 3_000, user_uid: "u-jeff", business_id: bizJeffId, location_id: amparoId, cash_session_id: amparoOpenSessionId, payment_status: "paid", process_status: "complete", created_at: OUT_OF_RANGE_AT },
      { customer_id: null, total_amount: 2_000, user_uid: "u-jeff", business_id: bizJeffId, location_id: britaliaId, cash_session_id: britaliaOpenSessionId, payment_status: "paid", process_status: "complete", created_at: SALE_AT },
      { customer_id: null, total_amount: 99_000, user_uid: "u-other", business_id: bizOtherId, location_id: otherLocationId, cash_session_id: otherLocationSessionId, payment_status: "paid", process_status: "complete", created_at: SALE_AT },
    ])
    .returning();
  const [a1, a2, a3, a4, a5, b1, o1] = insertedOrders;

  await db.insert(schema.orderPayments).values([
    { order_id: a1.id, payment_method_id: pmCashId, cash_session_id: amparoOpenSessionId, amount: 6_000, created_by_user_id: "u-jeff" },
    { order_id: a1.id, payment_method_id: pmTransferId, cash_session_id: amparoOpenSessionId, amount: 4_000, created_by_user_id: "u-jeff" },
    { order_id: a2.id, payment_method_id: pmCashId, cash_session_id: amparoOpenSessionId, amount: 5_000, created_by_user_id: "u-jeff" },
    { order_id: a3.id, payment_method_id: pmCashId, cash_session_id: amparoOpenSessionId, amount: 8_000, created_by_user_id: "u-jeff" },
    { order_id: a4.id, payment_method_id: pmCashId, cash_session_id: amparoOpenSessionId, amount: 7_000, created_by_user_id: "u-jeff" },
    { order_id: a5.id, payment_method_id: pmCashId, cash_session_id: amparoOpenSessionId, amount: 3_000, created_by_user_id: "u-jeff" },
    { order_id: b1.id, payment_method_id: pmTransferId, cash_session_id: britaliaOpenSessionId, amount: 2_000, created_by_user_id: "u-jeff" },
    { order_id: o1.id, payment_method_id: pmCashId, cash_session_id: otherLocationSessionId, amount: 99_000, created_by_user_id: "u-other" },
  ]);
});

afterAll(async () => {
  await pg.close();
});

const callerJeff = (locationId?: number) =>
  factory(makeContext("u-jeff", { businessId: bizJeffId, locationId: locationId ?? null }));
const callerOther = () =>
  factory(makeContext("u-other", { businessId: bizOtherId }));
const callerOrphan = () => factory(makeContext("u-orphan"));

const baseInput = { rangeFrom: RANGE_FROM, rangeTo: RANGE_TO };

describe("dashboard.stats — shape and identity", () => {
  it("(1) returns business/scope/cashSession/sales/inventory/expensesPlaceholder shape", async () => {
    const stats = await callerJeff().stats(baseInput);
    expect(stats.business).toEqual({ id: bizJeffId, name: "Jeff Studio", slug: "jeff-dash" });
    expect(stats.scope.locationId).toBeNull();
    expect(stats.scope.rangeFrom).toEqual(RANGE_FROM);
    expect(stats.scope.rangeTo).toEqual(RANGE_TO);
    expect(stats.cashSession).toBeDefined();
    expect(stats.sales).toBeDefined();
    expect(stats.inventory).toBeDefined();
    expect(stats.expensesPlaceholder).toBeDefined();
  });
});

describe("dashboard.stats — sales filtering", () => {
  it("(2) sales.todayRevenue excludes voided orders", async () => {
    const stats = await callerJeff().stats(baseInput);
    // Complete orders for Jeff in range: A1=10000 + A2=5000 + B1=2000 = 17000.
    // Void A3=8000 must NOT appear here.
    expect(stats.sales.todayRevenue).toBe(17_000);
  });

  it("(3) sales.todayRevenue excludes pending orders", async () => {
    const stats = await callerJeff().stats(baseInput);
    // A4 is pending=7000, must not be summed.
    expect(stats.sales.todayRevenue).toBe(17_000);
    expect(stats.sales.todayCount).toBe(3);
  });

  it("(4) voidedRevenue and voidedCount are computed from process_status='void'", async () => {
    const stats = await callerJeff().stats(baseInput);
    expect(stats.sales.voidedCount).toBe(1);
    expect(stats.sales.voidedRevenue).toBe(8_000);
  });

  it("(5) cross-business isolation: dashboard for biz A does not see biz B orders", async () => {
    const jeff = await callerJeff().stats(baseInput);
    const other = await callerOther().stats(baseInput);
    expect(jeff.sales.todayRevenue).toBe(17_000);
    expect(other.sales.todayRevenue).toBe(99_000);
    expect(jeff.business.id).not.toBe(other.business.id);
  });
});

describe("dashboard.stats — per-location scope", () => {
  it("(6) with locationId, cashSession.status='open' for that location's open session", async () => {
    const stats = await callerJeff().stats({ ...baseInput, locationId: amparoId });
    expect(stats.scope.locationId).toBe(amparoId);
    expect(stats.cashSession.status).toBe("open");
    expect(stats.cashSession.expectedCash).toBe(80_000);
    expect(stats.cashSession.expectedDigital).toBe(30_000);
  });

  it("(7) with locationId, sales filter to only that location's orders", async () => {
    const amparo = await callerJeff().stats({ ...baseInput, locationId: amparoId });
    expect(amparo.sales.todayRevenue).toBe(15_000); // A1+A2
    expect(amparo.sales.todayCount).toBe(2);

    const britalia = await callerJeff().stats({ ...baseInput, locationId: britaliaId });
    expect(britalia.sales.todayRevenue).toBe(2_000); // B1
    expect(britalia.sales.todayCount).toBe(1);
  });
});

describe("dashboard.stats — payment method aggregation", () => {
  it("(8) byPaymentMethod aggregates correctly across multiple methods", async () => {
    const stats = await callerJeff().stats(baseInput);
    const byMethod = Object.fromEntries(
      stats.sales.byPaymentMethod.map((r) => [r.name, r.total]),
    );
    // Complete orders only: A1 (cash 6000 + transfer 4000), A2 (cash 5000),
    // B1 (transfer 2000). Voided/pending excluded.
    // Expected: Cash = 11000, Transfer = 6000.
    expect(byMethod["Cash"]).toBe(11_000);
    expect(byMethod["Transfer"]).toBe(6_000);
  });
});

describe("dashboard.stats — inventory low stock", () => {
  it("(9) lowStock lists products with quantity_on_hand < 5 across the business", async () => {
    const stats = await callerJeff().stats(baseInput);
    // Jeff: lowProduct@Amparo=2, blackProduct@Britalia=1. Two rows.
    expect(stats.inventory.lowStockCount).toBe(2);
    const names = stats.inventory.lowStock.map((r) => r.productName).sort();
    expect(names).toEqual(["Black Ink", "Low Stock Item"]);
    // Sorted asc by quantity → Black (1) before Low (2).
    expect(stats.inventory.lowStock[0].quantityOnHand).toBe(1);
    expect(stats.inventory.lowStock[0].locationId).toBe(britaliaId);
  });
});

describe("dashboard.stats — expenses placeholder", () => {
  it("(10) expensesPlaceholder.monthTotal=0 with documented note", async () => {
    const stats = await callerJeff().stats(baseInput);
    expect(stats.expensesPlaceholder.monthTotal).toBe(0);
    expect(stats.expensesPlaceholder.note).toMatch(/Batch 6/);
  });
});

describe("dashboard.stats — range filter", () => {
  it("(11) orders outside rangeFrom/rangeTo are excluded", async () => {
    // A5 is at 2026-01-10 (before range). Default range filter excludes it.
    const stats = await callerJeff().stats(baseInput);
    expect(stats.sales.todayRevenue).toBe(17_000);

    // Widen the range to include 2026-01-10 and A5 (3000) appears.
    const wide = await callerJeff().stats({
      rangeFrom: new Date("2026-01-01T00:00:00Z"),
      rangeTo: RANGE_TO,
    });
    expect(wide.sales.todayRevenue).toBe(20_000);
  });
});

describe("dashboard.stats — authorization", () => {
  it("(12) FORBIDDEN when user has no membership in any business", async () => {
    await expect(callerOrphan().stats(baseInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    } satisfies Partial<TRPCError>);
  });

  it("FORBIDDEN when locationId belongs to another business", async () => {
    await expect(
      callerJeff().stats({ ...baseInput, locationId: otherLocationId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("cashSession.status='none' when locationId omitted", async () => {
    const stats = await callerJeff().stats(baseInput);
    expect(stats.cashSession.status).toBe("none");
    expect(stats.cashSession.expectedCash).toBe(0);
    expect(stats.cashSession.expectedDigital).toBe(0);
  });
});
