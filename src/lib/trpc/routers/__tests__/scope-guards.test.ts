import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { assertLocationAllowed } = await import("../../scope-guards");
const { inventoryRouter } = await import("../inventory");
const { ordersRouter } = await import("../orders");
const { cashSessionsRouter } = await import("../cash-sessions");
const { dashboardRouter } = await import("../dashboard");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const inventoryCallerFactory = createCallerFactory(inventoryRouter);
const ordersCallerFactory = createCallerFactory(ordersRouter);
const cashCallerFactory = createCallerFactory(cashSessionsRouter);
const dashboardCallerFactory = createCallerFactory(dashboardRouter);

let bizJeffId: number;
let amparoId: number;
let britaliaId: number;
let pinkProductId: number;
let blackProductId: number;
let cashMethodId: number;
let amparoOpenSessionId: number;
let amparoOrderId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-broad", name: "Broad", email: "broad@t.com", emailVerified: false, image: null },
    { id: "u-granular", name: "Granular", email: "granular@t.com", emailVerified: false, image: null },
  ]);

  const [bizJeff] = await db
    .insert(schema.businesses)
    .values([{ name: "Jeff Studio", slug: "scope-jeff" }])
    .returning();
  bizJeffId = bizJeff.id;

  await db.insert(schema.businessMembers).values([
    { business_id: bizJeffId, user_id: "u-broad", role: "owner", status: "active" },
  ]);

  const insertedLocations = await db
    .insert(schema.locations)
    .values([
      { business_id: bizJeffId, name: "Amparo", slug: "scope-amparo" },
      { business_id: bizJeffId, name: "Britalia", slug: "scope-britalia" },
    ])
    .returning();
  amparoId = insertedLocations[0].id;
  britaliaId = insertedLocations[1].id;

  // Granular user: only at Amparo, role=cashier (so operationalRole guard
  // accepts orders.create).
  await db.insert(schema.locationMembers).values([
    {
      business_id: bizJeffId,
      location_id: amparoId,
      user_id: "u-granular",
      role: "cashier",
      status: "active",
    },
  ]);

  const insertedProducts = await db
    .insert(schema.products)
    .values([
      {
        name: "Pink Ink",
        price: 5_000,
        in_stock: 0,
        user_uid: "u-broad",
        business_id: bizJeffId,
        sku: "SCOPE-PINK",
        cost_amount: 2_500,
        status: "active",
      },
      {
        name: "Black Ink",
        price: 5_000,
        in_stock: 0,
        user_uid: "u-broad",
        business_id: bizJeffId,
        sku: "SCOPE-BLACK",
        cost_amount: 2_400,
        status: "active",
      },
    ])
    .returning();
  pinkProductId = insertedProducts[0].id;
  blackProductId = insertedProducts[1].id;

  await db.insert(schema.inventoryBalances).values([
    {
      business_id: bizJeffId,
      location_id: amparoId,
      product_id: pinkProductId,
      quantity_on_hand: 20,
      quantity_reserved: 0,
    },
    {
      business_id: bizJeffId,
      location_id: britaliaId,
      product_id: blackProductId,
      quantity_on_hand: 20,
      quantity_reserved: 0,
    },
  ]);

  const [cashMethod] = await db
    .insert(schema.paymentMethods)
    .values({ name: "Cash", type: "cash", code: "cash", business_id: bizJeffId })
    .returning();
  cashMethodId = cashMethod.id;

  // Open cash sessions at both sedes so orders.create / cashSessions.open
  // tests have a happy path to compare against.
  const insertedSessions = await db
    .insert(schema.cashSessions)
    .values([
      {
        business_id: bizJeffId,
        location_id: amparoId,
        opened_by_user_id: "u-broad",
        opening_cash_amount: 0,
        expected_cash_amount: 0,
        expected_digital_amount: 0,
        status: "open",
      },
    ])
    .returning();
  amparoOpenSessionId = insertedSessions[0].id;

  // Pre-existing order at Britalia (broad user created it). Used to test
  // orders.void rejection when granular user has no scope at Britalia.
  const [orderRow] = await db
    .insert(schema.orders)
    .values({
      total_amount: 5_000,
      user_uid: "u-broad",
      business_id: bizJeffId,
      location_id: britaliaId,
      cash_session_id: amparoOpenSessionId,
      payment_status: "paid",
      process_status: "complete",
    })
    .returning();
  amparoOrderId = orderRow.id;
});

afterAll(async () => {
  await pg.close();
});

const broadCtx = () =>
  makeContext("u-broad", {
    businessId: bizJeffId,
    locationId: amparoId,
    role: "owner",
    isLocationScoped: false,
    effectiveLocationIds: [amparoId, britaliaId],
  });

const granularCtx = () =>
  makeContext("u-granular", {
    businessId: bizJeffId,
    locationId: amparoId,
    role: "cashier",
    isLocationScoped: true,
    effectiveLocationIds: [amparoId],
  });

describe("assertLocationAllowed helper", () => {
  it("is a no-op for broad users (isLocationScoped=false)", () => {
    const ctx = broadCtx();
    expect(() => assertLocationAllowed(ctx, britaliaId)).not.toThrow();
    // Even an arbitrary id passes for broad users — broad scope is enforced
    // elsewhere (membership / business_id checks per router).
    expect(() => assertLocationAllowed(ctx, 99_999)).not.toThrow();
  });

  it("allows granular users on locations they belong to", () => {
    const ctx = granularCtx();
    expect(() => assertLocationAllowed(ctx, amparoId)).not.toThrow();
  });

  it("rejects FORBIDDEN for granular users on locations outside scope", () => {
    const ctx = granularCtx();
    expect(() => assertLocationAllowed(ctx, britaliaId)).toThrow(TRPCError);
    try {
      assertLocationAllowed(ctx, britaliaId);
    } catch (err) {
      expect((err as TRPCError).code).toBe("FORBIDDEN");
    }
  });
});

describe("inventory.* enforces effectiveLocationIds for granular users", () => {
  it("balancesByLocation: granular cannot read britalia balances", async () => {
    await expect(
      inventoryCallerFactory(granularCtx()).balancesByLocation({
        locationId: britaliaId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("adjust: granular cannot adjust britalia stock", async () => {
    await expect(
      inventoryCallerFactory(granularCtx()).adjust({
        productId: blackProductId,
        locationId: britaliaId,
        quantityDelta: 1,
        type: "adjustment",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("transfer: granular cannot transfer FROM britalia even if TO is allowed", async () => {
    await expect(
      inventoryCallerFactory(granularCtx()).transfer({
        productId: blackProductId,
        fromLocationId: britaliaId,
        toLocationId: amparoId,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("cashSessions.open: granular scope enforcement", () => {
  it("granular user cannot open cash at unauthorized location", async () => {
    await expect(
      cashCallerFactory(granularCtx()).open({
        locationId: britaliaId,
        openingCashAmount: 0,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("orders.create: granular scope enforcement", () => {
  it("granular user cannot create order at unauthorized location", async () => {
    await expect(
      ordersCallerFactory(granularCtx()).create({
        locationId: britaliaId,
        items: [{ productId: blackProductId, quantity: 1 }],
        paymentLines: [{ paymentMethodId: cashMethodId, amount: 5_000 }],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("orders.void: granular scope enforcement", () => {
  it("granular user cannot void an order whose location is outside scope", async () => {
    await expect(
      ordersCallerFactory(granularCtx()).void({
        orderId: amparoOrderId,
        voidanceReason: "test",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("dashboard.stats: granular scope enforcement", () => {
  it("rejects when explicit locationId is outside scope", async () => {
    await expect(
      dashboardCallerFactory(granularCtx()).stats({
        locationId: britaliaId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});
