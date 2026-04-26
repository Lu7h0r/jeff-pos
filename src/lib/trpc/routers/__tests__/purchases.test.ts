import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { purchasesRouter } = await import("../purchases");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(purchasesRouter);
const callerAs = (uid: string, businessId: number | null = null) =>
  factory(makeContext(uid, { businessId }));

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let britaliaId: number;
let otherLocationId: number;
let pmCashId: number;
let pmTransferId: number;
let openSessionId: number;
let inkProductId: number;
let needleProductId: number;
let otherBizProductId: number;
let demoSupplierId: number;
let otherBizSupplierId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff-pur@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-pur@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-pur" },
      { name: "Other Studio", slug: "other-pur" },
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
      { business_id: bizJeffId, name: "Amparo", slug: "amparo" },
      { business_id: bizJeffId, name: "Britalia", slug: "britalia" },
      { business_id: bizOtherId, name: "Other", slug: "other-loc" },
    ])
    .returning();
  amparoId = locs[0].id;
  britaliaId = locs[1].id;
  otherLocationId = locs[2].id;

  const [pmCash, pmTransfer] = await db
    .insert(schema.paymentMethods)
    .values([{ name: "Cash" }, { name: "Transfer" }])
    .returning();
  pmCashId = pmCash.id;
  pmTransferId = pmTransfer.id;

  const [openSession] = await db
    .insert(schema.cashSessions)
    .values({
      business_id: bizJeffId,
      location_id: amparoId,
      opened_by_user_id: "u-jeff",
      opening_cash_amount: 500_000,
      expected_cash_amount: 500_000,
      expected_digital_amount: 0,
      status: "open",
    })
    .returning();
  openSessionId = openSession.id;

  const prods = await db
    .insert(schema.products)
    .values([
      { name: "Ink", price: 10_000, in_stock: 0, user_uid: "u-jeff", business_id: bizJeffId, sku: "INK", cost_amount: 5_000, status: "active" },
      { name: "Needle", price: 5_000, in_stock: 0, user_uid: "u-jeff", business_id: bizJeffId, sku: "NDL", cost_amount: 2_000, status: "active" },
      { name: "OtherInk", price: 1_000, in_stock: 0, user_uid: "u-other", business_id: bizOtherId, sku: "INK-O", cost_amount: 500, status: "active" },
    ])
    .returning();
  inkProductId = prods[0].id;
  needleProductId = prods[1].id;
  otherBizProductId = prods[2].id;

  const sups = await db
    .insert(schema.suppliers)
    .values([
      { business_id: bizJeffId, name: "Demo Supplier" },
      { business_id: bizOtherId, name: "Other Supplier" },
    ])
    .returning();
  demoSupplierId = sups[0].id;
  otherBizSupplierId = sups[1].id;
});

afterAll(async () => {
  await pg.close();
});

describe("purchases.create", () => {
  it("persists order + items with computed total", async () => {
    const order = await callerAs("u-jeff", bizJeffId).create({
      locationId: amparoId,
      supplierId: demoSupplierId,
      items: [
        { productId: inkProductId, quantity: 5, unitCost: 4_000 },
        { productId: needleProductId, quantity: 10, unitCost: 1_500 },
      ],
    });
    expect(order.business_id).toBe(bizJeffId);
    expect(order.location_id).toBe(amparoId);
    expect(order.supplier_id).toBe(demoSupplierId);
    expect(order.status).toBe("draft");
    expect(order.total_amount).toBe(5 * 4_000 + 10 * 1_500);
    expect(order.items.length).toBe(2);
    expect(order.items.find((i) => i.product_id === inkProductId)!.total_cost).toBe(20_000);
  });

  it("writes cash_movement (manual_out) when paid from open cash session", async () => {
    const [sessionBefore] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, openSessionId));
    const expectedBefore = sessionBefore.expected_cash_amount;

    const order = await callerAs("u-jeff", bizJeffId).create({
      locationId: amparoId,
      items: [{ productId: inkProductId, quantity: 1, unitCost: 3_000 }],
      paymentMethodId: pmCashId,
      cashSessionId: openSessionId,
    });

    const movements = await db
      .select()
      .from(schema.cashMovements)
      .where(
        and(
          eq(schema.cashMovements.source_type, "purchase_order"),
          eq(schema.cashMovements.source_id, order.id),
        ),
      );
    expect(movements.length).toBe(1);
    expect(movements[0].amount).toBe(-3_000);
    expect(movements[0].type).toBe("manual_out");
    expect(movements[0].transaction_type).toBe("negative");

    const [sessionAfter] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, openSessionId));
    expect(sessionAfter.expected_cash_amount).toBe(expectedBefore - 3_000);
  });

  it("rejects when product belongs to another business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).create({
        locationId: amparoId,
        items: [{ productId: otherBizProductId, quantity: 1, unitCost: 100 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("rejects when supplier belongs to another business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).create({
        locationId: amparoId,
        supplierId: otherBizSupplierId,
        items: [{ productId: inkProductId, quantity: 1, unitCost: 100 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("rejects when location belongs to another business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).create({
        locationId: otherLocationId,
        items: [{ productId: inkProductId, quantity: 1, unitCost: 100 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("purchases.receive", () => {
  it("increments inventory_balances at the correct location and writes movement type=purchase", async () => {
    const order = await callerAs("u-jeff", bizJeffId).create({
      locationId: britaliaId,
      items: [{ productId: needleProductId, quantity: 7, unitCost: 1_800 }],
    });
    const received = await callerAs("u-jeff", bizJeffId).receive({
      purchaseOrderId: order.id,
    });
    expect(received.status).toBe("received");
    expect(received.received_at).not.toBeNull();

    const [bal] = await db
      .select()
      .from(schema.inventoryBalances)
      .where(
        and(
          eq(schema.inventoryBalances.location_id, britaliaId),
          eq(schema.inventoryBalances.product_id, needleProductId),
        ),
      );
    expect(bal.quantity_on_hand).toBe(7);

    const movements = await db
      .select()
      .from(schema.inventoryMovements)
      .where(
        and(
          eq(schema.inventoryMovements.source_type, "purchase_order"),
          eq(schema.inventoryMovements.source_id, order.id),
        ),
      );
    expect(movements.length).toBe(1);
    expect(movements[0].type).toBe("purchase");
    expect(movements[0].quantity_delta).toBe(7);
    expect(movements[0].location_id).toBe(britaliaId);
  });

  it("updates products.cost_amount with the most recent unit_cost", async () => {
    const order = await callerAs("u-jeff", bizJeffId).create({
      locationId: amparoId,
      items: [{ productId: inkProductId, quantity: 2, unitCost: 9_999 }],
    });
    await callerAs("u-jeff", bizJeffId).receive({ purchaseOrderId: order.id });

    const [product] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, inkProductId));
    expect(product.cost_amount).toBe(9_999);
  });

  it("rejects on non-draft status (CONFLICT)", async () => {
    const order = await callerAs("u-jeff", bizJeffId).create({
      locationId: amparoId,
      items: [{ productId: inkProductId, quantity: 1, unitCost: 100 }],
    });
    await callerAs("u-jeff", bizJeffId).receive({ purchaseOrderId: order.id });
    await expect(
      callerAs("u-jeff", bizJeffId).receive({ purchaseOrderId: order.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });
});

describe("purchases.cancel", () => {
  it("reverses cash_movement when one was written", async () => {
    const [sessionBefore] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, openSessionId));
    const expectedBefore = sessionBefore.expected_cash_amount;

    const order = await callerAs("u-jeff", bizJeffId).create({
      locationId: amparoId,
      items: [{ productId: inkProductId, quantity: 1, unitCost: 4_000 }],
      paymentMethodId: pmCashId,
      cashSessionId: openSessionId,
    });
    const cancelled = await callerAs("u-jeff", bizJeffId).cancel({
      purchaseOrderId: order.id,
      reason: "supplier no-show",
    });
    expect(cancelled.status).toBe("cancelled");

    const reversal = await db
      .select()
      .from(schema.cashMovements)
      .where(
        and(
          eq(schema.cashMovements.source_type, "purchase_order_cancel"),
          eq(schema.cashMovements.source_id, order.id),
        ),
      );
    expect(reversal.length).toBe(1);
    expect(reversal[0].amount).toBe(4_000);
    expect(reversal[0].type).toBe("manual_in");

    const [sessionAfter] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, openSessionId));
    expect(sessionAfter.expected_cash_amount).toBe(expectedBefore);
  });

  it("rejects if status=received (CONFLICT)", async () => {
    const order = await callerAs("u-jeff", bizJeffId).create({
      locationId: amparoId,
      items: [{ productId: inkProductId, quantity: 1, unitCost: 100 }],
    });
    await callerAs("u-jeff", bizJeffId).receive({ purchaseOrderId: order.id });
    await expect(
      callerAs("u-jeff", bizJeffId).cancel({ purchaseOrderId: order.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });
});

describe("purchases cross-business isolation", () => {
  it("purchase from biz A invisible from biz B (and forbidden to act on)", async () => {
    const orderA = await callerAs("u-jeff", bizJeffId).create({
      locationId: amparoId,
      items: [{ productId: inkProductId, quantity: 1, unitCost: 100 }],
    });

    const otherList = await callerAs("u-other", bizOtherId).list({});
    expect(otherList.some((p) => p.id === orderA.id)).toBe(false);

    await expect(
      callerAs("u-other", bizOtherId).receive({ purchaseOrderId: orderA.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});
