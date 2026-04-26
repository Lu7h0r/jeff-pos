import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { eq, and, desc } from "drizzle-orm";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { ordersRouter } = await import("../orders");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(ordersRouter);
const callerAs = (uid: string, businessId?: number) =>
  factory(makeContext(uid, { businessId: businessId ?? null }));

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let britaliaId: number;
let otherLocationId: number;
let pinkProductId: number;
let blackProductId: number;
let otherBizProductId: number;
let inactiveProductId: number;
let customerId: number;
let pmCashId: number;
let pmTransferId: number;
let pmOtherBizId: number;
let amparoSessionId: number;
let britaliaSessionId: number;
let amparoClosedSessionId: number;
let otherLocationSessionId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff-orders@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-orders@test.com", emailVerified: false, image: null },
    { id: "u-orphan", name: "Orphan", email: "orphan-orders@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-orders" },
      { name: "Other Studio", slug: "other-orders" },
    ])
    .returning();
  bizJeffId = bizJeff.id;
  bizOtherId = bizOther.id;

  await db.insert(schema.businessMembers).values([
    { business_id: bizJeffId, user_id: "u-jeff", role: "owner", status: "active" },
    { business_id: bizOtherId, user_id: "u-other", role: "owner", status: "active" },
  ]);

  const inserted = await db
    .insert(schema.locations)
    .values([
      { business_id: bizJeffId, name: "Amparo", slug: "amparo" },
      { business_id: bizJeffId, name: "Britalia", slug: "britalia" },
      { business_id: bizOtherId, name: "Other Location", slug: "other-loc" },
    ])
    .returning();
  amparoId = inserted[0].id;
  britaliaId = inserted[1].id;
  otherLocationId = inserted[2].id;

  const insertedProducts = await db
    .insert(schema.products)
    .values([
      { name: "Pink Ink", price: 1000, in_stock: 0, user_uid: "u-jeff", business_id: bizJeffId, sku: "INK-PINK", cost_amount: 400, status: "active" },
      { name: "Black Ink", price: 2_000, in_stock: 0, user_uid: "u-jeff", business_id: bizJeffId, sku: "INK-BLACK", cost_amount: 900, status: "active" },
      { name: "Other Biz Ink", price: 500, in_stock: 0, user_uid: "u-other", business_id: bizOtherId, sku: "INK-OTHER", cost_amount: 200, status: "active" },
      { name: "Discontinued", price: 100, in_stock: 0, user_uid: "u-jeff", business_id: bizJeffId, sku: "OLD", cost_amount: 50, status: "archived" },
    ])
    .returning();
  pinkProductId = insertedProducts[0].id;
  blackProductId = insertedProducts[1].id;
  otherBizProductId = insertedProducts[2].id;
  inactiveProductId = insertedProducts[3].id;

  const [cust] = await db
    .insert(schema.customers)
    .values({
      name: "Walk-in Jeff",
      email: "walkin-jeff@orders.test",
      user_uid: "u-jeff",
      business_id: bizJeffId,
    })
    .returning();
  customerId = cust.id;

  const [pmCash, pmTransfer, pmOtherBiz] = await db
    .insert(schema.paymentMethods)
    .values([
      { name: "Cash" },
      { name: "Transfer" },
      { name: "OtherBizCard", business_id: bizOtherId },
    ])
    .returning();
  pmCashId = pmCash.id;
  pmTransferId = pmTransfer.id;
  pmOtherBizId = pmOtherBiz.id;

  // Stock: Pink at Amparo=20, Britalia=5; Black at Amparo=10, Britalia=0;
  // Other Biz Ink at otherLocation=10. inventory_balances row missing for
  // (Britalia, Black) so we can exercise the "no row" CONFLICT path.
  await db.insert(schema.inventoryBalances).values([
    { business_id: bizJeffId, location_id: amparoId, product_id: pinkProductId, quantity_on_hand: 20, quantity_reserved: 0 },
    { business_id: bizJeffId, location_id: britaliaId, product_id: pinkProductId, quantity_on_hand: 5, quantity_reserved: 0 },
    { business_id: bizJeffId, location_id: amparoId, product_id: blackProductId, quantity_on_hand: 10, quantity_reserved: 0 },
    { business_id: bizOtherId, location_id: otherLocationId, product_id: otherBizProductId, quantity_on_hand: 10, quantity_reserved: 0 },
  ]);

  // Open cash sessions: Amparo open, Britalia open, otherLocation open.
  // Britalia gets a separate closed session reused later for "void on
  // closed session" validation.
  const sessions = await db
    .insert(schema.cashSessions)
    .values([
      {
        business_id: bizJeffId,
        location_id: amparoId,
        opened_by_user_id: "u-jeff",
        opening_cash_amount: 50_000,
        expected_cash_amount: 50_000,
        expected_digital_amount: 0,
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
  amparoSessionId = sessions[0].id;
  britaliaSessionId = sessions[1].id;
  otherLocationSessionId = sessions[2].id;
});

afterAll(async () => {
  await pg.close();
});

const jeffCaller = () => callerAs("u-jeff", bizJeffId);
const otherCaller = () => callerAs("u-other", bizOtherId);
const orphanCaller = () => callerAs("u-orphan");

describe("orders.create — atomic POS sale", () => {
  it("(1) cash sale decrements stock, writes one sale movement, payment, cash movement and updates session", async () => {
    const sessionBefore = (
      await db.select().from(schema.cashSessions).where(eq(schema.cashSessions.id, amparoSessionId))
    )[0];
    const [balanceBefore] = await db
      .select()
      .from(schema.inventoryBalances)
      .where(
        and(
          eq(schema.inventoryBalances.location_id, amparoId),
          eq(schema.inventoryBalances.product_id, pinkProductId),
        ),
      );

    const order = await jeffCaller().create({
      locationId: amparoId,
      customerId,
      items: [{ productId: pinkProductId, quantity: 2 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 2_000 }],
    });

    expect(order.total_amount).toBe(2_000);
    expect(order.payment_status).toBe("paid");
    expect(order.process_status).toBe("complete");
    expect(order.business_id).toBe(bizJeffId);
    expect(order.location_id).toBe(amparoId);
    expect(order.cash_session_id).toBe(amparoSessionId);
    expect(order.items.length).toBe(1);
    expect(order.items[0].quantity).toBe(2);
    expect(order.items[0].unit_price).toBe(1_000);
    expect(order.items[0].total_price).toBe(2_000);
    expect(order.payments.length).toBe(1);
    expect(order.payments[0].amount).toBe(2_000);

    const [balanceAfter] = await db
      .select()
      .from(schema.inventoryBalances)
      .where(eq(schema.inventoryBalances.id, balanceBefore.id));
    expect(balanceAfter.quantity_on_hand).toBe(balanceBefore.quantity_on_hand - 2);

    const movements = await db
      .select()
      .from(schema.inventoryMovements)
      .where(
        and(
          eq(schema.inventoryMovements.source_type, "order"),
          eq(schema.inventoryMovements.source_id, order.id),
        ),
      );
    expect(movements.length).toBe(1);
    expect(movements[0].type).toBe("sale");
    expect(movements[0].quantity_delta).toBe(-2);

    const cashMovements = await db
      .select()
      .from(schema.cashMovements)
      .where(eq(schema.cashMovements.cash_session_id, amparoSessionId));
    const last = cashMovements.at(-1)!;
    expect(last.type).toBe("sale");
    expect(last.amount).toBe(2_000);
    expect(last.transaction_type).toBe("positive");
    expect(last.balance_after - last.balance_before).toBe(2_000);

    const [sessionAfter] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, amparoSessionId));
    expect(sessionAfter.expected_cash_amount).toBe(
      sessionBefore.expected_cash_amount + 2_000,
    );
  });

  it("(2) multi-payment (cash + transfer) creates two payments and two cash movements", async () => {
    const order = await jeffCaller().create({
      locationId: amparoId,
      customerId,
      items: [{ productId: blackProductId, quantity: 1 }],
      paymentLines: [
        { paymentMethodId: pmCashId, amount: 1_500 },
        { paymentMethodId: pmTransferId, amount: 500 },
      ],
    });

    expect(order.total_amount).toBe(2_000);
    expect(order.payments.length).toBe(2);

    const cashMovements = await db
      .select()
      .from(schema.cashMovements)
      .where(eq(schema.cashMovements.source_id, order.id));
    expect(cashMovements.length).toBe(2);
    const sumAmounts = cashMovements.reduce((s, m) => s + m.amount, 0);
    expect(sumAmounts).toBe(2_000);
    expect(new Set(cashMovements.map((m) => m.payment_method_id))).toEqual(
      new Set([pmCashId, pmTransferId]),
    );
  });

  it("(3) server recomputes total from DB prices (client cannot supply unit price)", async () => {
    // No total field exists on the input contract. Verify the input.items
    // schema rejects extra `price` keys (zod strict by default? — it strips
    // by default). Either way, the server-derived total is sourced from
    // products.price at sale time. Assert by selling 3 units of Pink at
    // price 1000 → total must be 3000 even if the test never passes any.
    const order = await jeffCaller().create({
      locationId: amparoId,
      items: [{ productId: pinkProductId, quantity: 3 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 3_000 }],
    });
    expect(order.total_amount).toBe(3_000);
    expect(order.items[0].unit_price).toBe(1_000);
  });

  it("(4) rejects when sum(paymentLines) !== computed total (BAD_REQUEST)", async () => {
    await expect(
      jeffCaller().create({
        locationId: amparoId,
        items: [{ productId: pinkProductId, quantity: 1 }],
        paymentLines: [{ paymentMethodId: pmCashId, amount: 999 }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" } satisfies Partial<TRPCError>);
  });

  it("(5) rejects when stock at the location is insufficient (CONFLICT); other location not consulted", async () => {
    // Britalia has 5 Pink Ink units; ask for 100.
    await expect(
      jeffCaller().create({
        locationId: britaliaId,
        items: [{ productId: pinkProductId, quantity: 100 }],
        paymentLines: [{ paymentMethodId: pmCashId, amount: 100_000 }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);

    // Stock at Amparo (other location) untouched.
    const [amparoBal] = await db
      .select()
      .from(schema.inventoryBalances)
      .where(
        and(
          eq(schema.inventoryBalances.location_id, amparoId),
          eq(schema.inventoryBalances.product_id, pinkProductId),
        ),
      );
    // Started at 20 → after tests 1 and 3 → 20-2-3=15
    expect(amparoBal.quantity_on_hand).toBe(15);
  });

  it("(6) rejects when no open cash session for the location (CONFLICT)", async () => {
    // Create a fresh location with no open session.
    const [tempLoc] = await db
      .insert(schema.locations)
      .values({ business_id: bizJeffId, name: "Temp NoCaja", slug: "temp-no-caja" })
      .returning();
    await db.insert(schema.inventoryBalances).values({
      business_id: bizJeffId,
      location_id: tempLoc.id,
      product_id: pinkProductId,
      quantity_on_hand: 5,
      quantity_reserved: 0,
    });

    await expect(
      jeffCaller().create({
        locationId: tempLoc.id,
        items: [{ productId: pinkProductId, quantity: 1 }],
        paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });

  it("(7) rejects when product belongs to another business (FORBIDDEN)", async () => {
    await expect(
      jeffCaller().create({
        locationId: amparoId,
        items: [{ productId: otherBizProductId, quantity: 1 }],
        paymentLines: [{ paymentMethodId: pmCashId, amount: 500 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("(8) rejects when user is not a member of the location's business (FORBIDDEN)", async () => {
    await expect(
      otherCaller().create({
        locationId: amparoId,
        items: [{ productId: pinkProductId, quantity: 1 }],
        paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    await expect(
      orphanCaller().create({
        locationId: amparoId,
        items: [{ productId: pinkProductId, quantity: 1 }],
        paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("(9) order_items snapshot is immune to later product edits", async () => {
    const order = await jeffCaller().create({
      locationId: amparoId,
      items: [{ productId: pinkProductId, quantity: 1 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
    });

    expect(order.items[0].product_name).toBe("Pink Ink");
    expect(order.items[0].unit_price).toBe(1_000);
    expect(order.items[0].unit_cost).toBe(400);

    await db
      .update(schema.products)
      .set({ name: "Renamed Pink", price: 9_999 })
      .where(eq(schema.products.id, pinkProductId));

    const [persisted] = await db
      .select()
      .from(schema.orderItems)
      .where(eq(schema.orderItems.order_id, order.id));
    expect(persisted.product_name).toBe("Pink Ink");
    expect(persisted.unit_price).toBe(1_000);
    expect(persisted.total_price).toBe(1_000);

    // restore for other tests
    await db
      .update(schema.products)
      .set({ name: "Pink Ink", price: 1_000 })
      .where(eq(schema.products.id, pinkProductId));
  });

  it("(10) rejects when product id does not exist (NOT_FOUND)", async () => {
    await expect(
      jeffCaller().create({
        locationId: amparoId,
        items: [{ productId: 9_999_999, quantity: 1 }],
        paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<TRPCError>);
  });

  it("(11) rejects quantity <= 0 via zod input validation (BAD_REQUEST)", async () => {
    await expect(
      jeffCaller().create({
        locationId: amparoId,
        items: [{ productId: pinkProductId, quantity: 0 }],
        paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
      }),
    ).rejects.toThrow();

    await expect(
      jeffCaller().create({
        locationId: amparoId,
        items: [{ productId: pinkProductId, quantity: -1 }],
        paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
      }),
    ).rejects.toThrow();
  });

  it("(12) cross-location isolation: stock decremented at Amparo does not affect Britalia", async () => {
    const [amparoBefore] = await db
      .select()
      .from(schema.inventoryBalances)
      .where(
        and(
          eq(schema.inventoryBalances.location_id, amparoId),
          eq(schema.inventoryBalances.product_id, pinkProductId),
        ),
      );
    const [britaliaBefore] = await db
      .select()
      .from(schema.inventoryBalances)
      .where(
        and(
          eq(schema.inventoryBalances.location_id, britaliaId),
          eq(schema.inventoryBalances.product_id, pinkProductId),
        ),
      );

    await jeffCaller().create({
      locationId: amparoId,
      items: [{ productId: pinkProductId, quantity: 1 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
    });

    const [amparoAfter] = await db
      .select()
      .from(schema.inventoryBalances)
      .where(eq(schema.inventoryBalances.id, amparoBefore.id));
    const [britaliaAfter] = await db
      .select()
      .from(schema.inventoryBalances)
      .where(eq(schema.inventoryBalances.id, britaliaBefore.id));

    expect(amparoAfter.quantity_on_hand).toBe(amparoBefore.quantity_on_hand - 1);
    expect(britaliaAfter.quantity_on_hand).toBe(britaliaBefore.quantity_on_hand);
  });

  it("rejects archived/inactive product (BAD_REQUEST)", async () => {
    await expect(
      jeffCaller().create({
        locationId: amparoId,
        items: [{ productId: inactiveProductId, quantity: 1 }],
        paymentLines: [{ paymentMethodId: pmCashId, amount: 100 }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" } satisfies Partial<TRPCError>);
  });

  it("rejects payment method belonging to another business (FORBIDDEN)", async () => {
    await expect(
      jeffCaller().create({
        locationId: amparoId,
        items: [{ productId: pinkProductId, quantity: 1 }],
        paymentLines: [{ paymentMethodId: pmOtherBizId, amount: 1_000 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("orders.void", () => {
  it("(13) marks order as voided with reason, voided_at and voided_by populated", async () => {
    const order = await jeffCaller().create({
      locationId: amparoId,
      items: [{ productId: pinkProductId, quantity: 1 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
    });

    const voided = await jeffCaller().void({
      orderId: order.id,
      voidanceReason: "Customer changed mind",
    });

    expect(voided.process_status).toBe("void");
    expect(voided.voidance_reason).toBe("Customer changed mind");
    expect(voided.voided_at).not.toBeNull();
    expect(voided.voided_by_user_id).toBe("u-jeff");
  });

  it("(14) creates reverse inventory_movements; balance returns to pre-sale level", async () => {
    const [before] = await db
      .select()
      .from(schema.inventoryBalances)
      .where(
        and(
          eq(schema.inventoryBalances.location_id, amparoId),
          eq(schema.inventoryBalances.product_id, blackProductId),
        ),
      );

    const order = await jeffCaller().create({
      locationId: amparoId,
      items: [{ productId: blackProductId, quantity: 2 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 4_000 }],
    });

    const [duringSale] = await db
      .select()
      .from(schema.inventoryBalances)
      .where(eq(schema.inventoryBalances.id, before.id));
    expect(duringSale.quantity_on_hand).toBe(before.quantity_on_hand - 2);

    await jeffCaller().void({ orderId: order.id, voidanceReason: "test reverse" });

    const [afterVoid] = await db
      .select()
      .from(schema.inventoryBalances)
      .where(eq(schema.inventoryBalances.id, before.id));
    expect(afterVoid.quantity_on_hand).toBe(before.quantity_on_hand);

    const reversals = await db
      .select()
      .from(schema.inventoryMovements)
      .where(
        and(
          eq(schema.inventoryMovements.source_type, "order_void"),
          eq(schema.inventoryMovements.source_id, order.id),
        ),
      );
    expect(reversals.length).toBe(1);
    expect(reversals[0].quantity_delta).toBe(2);
    expect(reversals[0].type).toBe("adjustment");
  });

  it("(15) creates reverse cash_movements with negative amount and transaction_type=negative; session expected balances revert", async () => {
    const [sessionBefore] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, britaliaSessionId));

    const order = await jeffCaller().create({
      locationId: britaliaId,
      items: [{ productId: pinkProductId, quantity: 1 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
    });

    const [sessionDuring] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, britaliaSessionId));
    expect(sessionDuring.expected_cash_amount).toBe(
      sessionBefore.expected_cash_amount + 1_000,
    );

    await jeffCaller().void({ orderId: order.id, voidanceReason: "rev cash" });

    const reverseCash = await db
      .select()
      .from(schema.cashMovements)
      .where(
        and(
          eq(schema.cashMovements.source_type, "order_void"),
          eq(schema.cashMovements.source_id, order.id),
        ),
      );
    expect(reverseCash.length).toBe(1);
    expect(reverseCash[0].type).toBe("refund");
    expect(reverseCash[0].amount).toBe(-1_000);
    expect(reverseCash[0].transaction_type).toBe("negative");

    const [sessionAfter] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, britaliaSessionId));
    expect(sessionAfter.expected_cash_amount).toBe(
      sessionBefore.expected_cash_amount,
    );
  });

  it("(16) rejects double-void (CONFLICT)", async () => {
    const order = await jeffCaller().create({
      locationId: amparoId,
      items: [{ productId: pinkProductId, quantity: 1 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
    });
    await jeffCaller().void({ orderId: order.id, voidanceReason: "first void" });

    await expect(
      jeffCaller().void({ orderId: order.id, voidanceReason: "second void" }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });

  it("(17) rejects void when the cash session is closed (CONFLICT)", async () => {
    // Open a fresh session at otherLocation so we can close it after a sale.
    const [tempLoc] = await db
      .insert(schema.locations)
      .values({ business_id: bizJeffId, name: "Temp Close", slug: "temp-close" })
      .returning();
    await db.insert(schema.inventoryBalances).values({
      business_id: bizJeffId,
      location_id: tempLoc.id,
      product_id: pinkProductId,
      quantity_on_hand: 5,
      quantity_reserved: 0,
    });

    const [tempSession] = await db
      .insert(schema.cashSessions)
      .values({
        business_id: bizJeffId,
        location_id: tempLoc.id,
        opened_by_user_id: "u-jeff",
        opening_cash_amount: 1_000,
        expected_cash_amount: 1_000,
        expected_digital_amount: 0,
        status: "open",
      })
      .returning();
    amparoClosedSessionId = tempSession.id;

    const order = await jeffCaller().create({
      locationId: tempLoc.id,
      items: [{ productId: pinkProductId, quantity: 1 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
    });

    await db
      .update(schema.cashSessions)
      .set({ status: "closed", closed_at: new Date(), counted_cash_amount: 2_000, difference_amount: 0 })
      .where(eq(schema.cashSessions.id, tempSession.id));

    await expect(
      jeffCaller().void({ orderId: order.id, voidanceReason: "after close" }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });

  it("(18) void by non-member rejects (FORBIDDEN)", async () => {
    const order = await jeffCaller().create({
      locationId: amparoId,
      items: [{ productId: pinkProductId, quantity: 1 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
    });

    await expect(
      otherCaller().void({ orderId: order.id, voidanceReason: "outsider" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    await expect(
      orphanCaller().void({ orderId: order.id, voidanceReason: "outsider" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("orders.editNotes — replaces retired orders.update (DA-8)", () => {
  it("updates only the notes field", async () => {
    const order = await jeffCaller().create({
      locationId: amparoId,
      items: [{ productId: pinkProductId, quantity: 1 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
      notes: "initial",
    });

    const updated = await jeffCaller().editNotes({
      orderId: order.id,
      notes: "edited via editNotes",
    });

    expect(updated.notes).toBe("edited via editNotes");

    const [persisted] = await db
      .select()
      .from(schema.orders)
      .where(eq(schema.orders.id, order.id));
    expect(persisted.notes).toBe("edited via editNotes");
  });

  it("does not change process_status, payment_status or total_amount", async () => {
    const order = await jeffCaller().create({
      locationId: amparoId,
      items: [{ productId: pinkProductId, quantity: 2 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 2_000 }],
    });

    const beforeRow = (
      await db.select().from(schema.orders).where(eq(schema.orders.id, order.id))
    )[0];

    await jeffCaller().editNotes({
      orderId: order.id,
      notes: "notes only — must not bleed into other columns",
    });

    const afterRow = (
      await db.select().from(schema.orders).where(eq(schema.orders.id, order.id))
    )[0];

    expect(afterRow.total_amount).toBe(beforeRow.total_amount);
    expect(afterRow.payment_status).toBe(beforeRow.payment_status);
    expect(afterRow.process_status).toBe(beforeRow.process_status);
    expect(afterRow.business_id).toBe(beforeRow.business_id);
    expect(afterRow.location_id).toBe(beforeRow.location_id);
    expect(afterRow.cash_session_id).toBe(beforeRow.cash_session_id);
    expect(afterRow.customer_id).toBe(beforeRow.customer_id);
  });

  it("rejects when caller is not a member of the order's business (FORBIDDEN)", async () => {
    const order = await jeffCaller().create({
      locationId: amparoId,
      items: [{ productId: pinkProductId, quantity: 1 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 1_000 }],
    });

    await expect(
      otherCaller().editNotes({ orderId: order.id, notes: "outsider note" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    await expect(
      orphanCaller().editNotes({ orderId: order.id, notes: "no membership" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("orders.list and orders.get", () => {
  it("orders.list scopes by business_id (does not leak across businesses)", async () => {
    // Seed an order for u-other at otherLocation
    await otherCaller().create({
      locationId: otherLocationId,
      items: [{ productId: otherBizProductId, quantity: 1 }],
      paymentLines: [{ paymentMethodId: pmCashId, amount: 500 }],
    });

    const jeffOrders = await jeffCaller().list();
    const otherOrders = await otherCaller().list();

    expect(jeffOrders.every((o) => o.business_id === bizJeffId)).toBe(true);
    expect(otherOrders.every((o) => o.business_id === bizOtherId)).toBe(true);
    expect(jeffOrders.length).toBeGreaterThan(0);
    expect(otherOrders.length).toBeGreaterThan(0);
  });
});
