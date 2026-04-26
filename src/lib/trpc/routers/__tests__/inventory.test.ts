import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import { createTestDb, makeUser, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { inventoryRouter } = await import("../inventory");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const caller = createCallerFactory(inventoryRouter);
const callerAs = (uid: string, locationId?: number) =>
  caller(makeContext(uid, { locationId: locationId ?? null }));

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let britaliaId: number;
let otherLocationId: number;
let pinkProductId: number;
let blackProductId: number;
let otherBizProductId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other@test.com", emailVerified: false, image: null },
    { id: "u-orphan", name: "Orphan", email: "orphan@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff" },
      { name: "Other Studio", slug: "other" },
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
      {
        name: "Pink Ink",
        price: 5_000,
        in_stock: 0,
        user_uid: "u-jeff",
        business_id: bizJeffId,
        sku: "INK-PINK",
        cost_amount: 2_500,
        status: "active",
      },
      {
        name: "Black Ink",
        price: 5_000,
        in_stock: 0,
        user_uid: "u-jeff",
        business_id: bizJeffId,
        sku: "INK-BLACK",
        cost_amount: 2_400,
        status: "active",
      },
      {
        name: "Other Biz Ink",
        price: 5_000,
        in_stock: 0,
        user_uid: "u-other",
        business_id: bizOtherId,
        sku: "INK-OTHER",
        cost_amount: 2_000,
        status: "active",
      },
    ])
    .returning();

  pinkProductId = insertedProducts[0].id;
  blackProductId = insertedProducts[1].id;
  otherBizProductId = insertedProducts[2].id;

  // Seed initial balances at Amparo only for Pink Ink (10 units) so
  // location-isolation can be observed. Britalia and Black Ink start
  // empty by default — tests will create those rows explicitly.
  await db.insert(schema.inventoryBalances).values({
    business_id: bizJeffId,
    location_id: amparoId,
    product_id: pinkProductId,
    quantity_on_hand: 10,
    quantity_reserved: 0,
  });

  // Seed Britalia with 4 units of Black Ink (used by movements + isolation)
  await db.insert(schema.inventoryBalances).values({
    business_id: bizJeffId,
    location_id: britaliaId,
    product_id: blackProductId,
    quantity_on_hand: 4,
    quantity_reserved: 0,
  });

  // Other business: 7 units at otherLocation for otherBizProduct (used by isolation)
  await db.insert(schema.inventoryBalances).values({
    business_id: bizOtherId,
    location_id: otherLocationId,
    product_id: otherBizProductId,
    quantity_on_hand: 7,
    quantity_reserved: 0,
  });
});

afterAll(async () => {
  await pg.close();
});

describe("inventory.balancesByLocation", () => {
  it("returns balances scoped to the active location only", async () => {
    const amparoRows = await callerAs("u-jeff").balancesByLocation({ locationId: amparoId });
    const britaliaRows = await callerAs("u-jeff").balancesByLocation({ locationId: britaliaId });

    expect(amparoRows.every((r) => r.location_id === amparoId)).toBe(true);
    expect(britaliaRows.every((r) => r.location_id === britaliaId)).toBe(true);

    const amparoProducts = amparoRows.map((r) => r.product_id).sort();
    const britaliaProducts = britaliaRows.map((r) => r.product_id).sort();

    expect(amparoProducts).toContain(pinkProductId);
    expect(amparoProducts).not.toContain(blackProductId);
    expect(britaliaProducts).toContain(blackProductId);
    expect(britaliaProducts).not.toContain(pinkProductId);
  });

  it("rejects when user is not a member of the location's business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-other").balancesByLocation({ locationId: amparoId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    await expect(
      callerAs("u-orphan").balancesByLocation({ locationId: amparoId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("inventory.adjust", () => {
  it("increments quantity and writes a movement row", async () => {
    const before = await db
      .select()
      .from(schema.inventoryBalances)
      .where(
        and(
          eq(schema.inventoryBalances.location_id, amparoId),
          eq(schema.inventoryBalances.product_id, pinkProductId),
        ),
      );
    const beforeQty = before[0].quantity_on_hand;

    const updated = await callerAs("u-jeff").adjust({
      productId: pinkProductId,
      locationId: amparoId,
      quantityDelta: 5,
      type: "adjustment",
      notes: "restock",
    });

    expect(updated.quantity_on_hand).toBe(beforeQty + 5);

    const movements = await db
      .select()
      .from(schema.inventoryMovements)
      .where(
        and(
          eq(schema.inventoryMovements.product_id, pinkProductId),
          eq(schema.inventoryMovements.location_id, amparoId),
          eq(schema.inventoryMovements.type, "adjustment"),
        ),
      );
    expect(movements.length).toBeGreaterThan(0);
    expect(movements.at(-1)!.quantity_delta).toBe(5);
  });

  it("decrements quantity when delta is negative", async () => {
    const before = await db
      .select()
      .from(schema.inventoryBalances)
      .where(
        and(
          eq(schema.inventoryBalances.location_id, amparoId),
          eq(schema.inventoryBalances.product_id, pinkProductId),
        ),
      );
    const beforeQty = before[0].quantity_on_hand;

    const updated = await callerAs("u-jeff").adjust({
      productId: pinkProductId,
      locationId: amparoId,
      quantityDelta: -3,
      type: "internal_consumption",
    });

    expect(updated.quantity_on_hand).toBe(beforeQty - 3);
  });

  // Documented choice: when an adjustment would leave quantity_on_hand
  // below zero we throw CONFLICT (not BAD_REQUEST). The state is valid
  // input but the business rule rejects the resulting state — same
  // semantics used by transfer when source has insufficient stock.
  it("rejects adjustment that would leave quantity_on_hand < 0 (CONFLICT)", async () => {
    await expect(
      callerAs("u-jeff").adjust({
        productId: pinkProductId,
        locationId: amparoId,
        quantityDelta: -9_999,
        type: "adjustment",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });

  it("rejects when user is not a member of the location's business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-other").adjust({
        productId: pinkProductId,
        locationId: amparoId,
        quantityDelta: 1,
        type: "adjustment",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("creates a new inventory_balance row when none exists (positive delta)", async () => {
    // Black Ink at Amparo — no row exists yet.
    const before = await db
      .select()
      .from(schema.inventoryBalances)
      .where(
        and(
          eq(schema.inventoryBalances.location_id, amparoId),
          eq(schema.inventoryBalances.product_id, blackProductId),
        ),
      );
    expect(before.length).toBe(0);

    const updated = await callerAs("u-jeff").adjust({
      productId: blackProductId,
      locationId: amparoId,
      quantityDelta: 8,
      type: "adjustment",
    });

    expect(updated.quantity_on_hand).toBe(8);
    expect(updated.business_id).toBe(bizJeffId);
    expect(updated.location_id).toBe(amparoId);
  });
});

describe("inventory.transfer", () => {
  it("moves quantity between two locations of the same business and creates linked movements", async () => {
    // Pink Ink: Amparo currently holds (10 + 5 - 3) = 12 from prior tests.
    // Britalia has no Pink Ink row yet.
    const transferQty = 4;

    const result = await callerAs("u-jeff").transfer({
      productId: pinkProductId,
      fromLocationId: amparoId,
      toLocationId: britaliaId,
      quantity: transferQty,
      notes: "rebalance",
    });

    expect(result.from.location_id).toBe(amparoId);
    expect(result.to.location_id).toBe(britaliaId);
    expect(result.from.quantity_on_hand).toBe(12 - transferQty);
    expect(result.to.quantity_on_hand).toBe(transferQty);
    expect(result.movementOutId).toBeGreaterThan(0);
    expect(result.movementInId).toBeGreaterThan(0);

    const [outRow] = await db
      .select()
      .from(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.id, result.movementOutId));
    const [inRow] = await db
      .select()
      .from(schema.inventoryMovements)
      .where(eq(schema.inventoryMovements.id, result.movementInId));

    expect(outRow.type).toBe("transfer_out");
    expect(outRow.quantity_delta).toBe(-transferQty);
    expect(outRow.source_type).toBe("transfer");
    expect(inRow.type).toBe("transfer_in");
    expect(inRow.quantity_delta).toBe(transferQty);
    expect(inRow.source_type).toBe("transfer");
    expect(inRow.source_id).toBe(outRow.id);
  });

  it("rejects when quantity exceeds source on_hand (CONFLICT)", async () => {
    await expect(
      callerAs("u-jeff").transfer({
        productId: pinkProductId,
        fromLocationId: amparoId,
        toLocationId: britaliaId,
        quantity: 9_999,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });

  it("rejects when from and to locations belong to different businesses (FORBIDDEN)", async () => {
    // u-jeff is not a member of the other business; the access check on
    // toLocation triggers FORBIDDEN before we even reach the same-business
    // assertion. That is the expected behaviour: cross-business transfers
    // are blocked at the membership boundary.
    await expect(
      callerAs("u-jeff").transfer({
        productId: pinkProductId,
        fromLocationId: amparoId,
        toLocationId: otherLocationId,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("inventory.movements", () => {
  it("returns recent movements filtered by location and product", async () => {
    const rows = await callerAs("u-jeff").movements({
      locationId: amparoId,
      productId: pinkProductId,
      limit: 100,
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.location_id === amparoId)).toBe(true);
    expect(rows.every((r) => r.product_id === pinkProductId)).toBe(true);
    expect(rows.every((r) => r.product_name === "Pink Ink")).toBe(true);
  });
});

describe("inventory cross-business isolation", () => {
  it("u-other never sees inventory of bizJeff via any operation", async () => {
    await expect(
      callerAs("u-other").balancesByLocation({ locationId: amparoId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    await expect(
      callerAs("u-other").movements({ locationId: amparoId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    await expect(
      callerAs("u-other").adjust({
        productId: pinkProductId,
        locationId: amparoId,
        quantityDelta: 1,
        type: "adjustment",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    await expect(
      callerAs("u-other").transfer({
        productId: pinkProductId,
        fromLocationId: amparoId,
        toLocationId: britaliaId,
        quantity: 1,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    // u-other can still see their own business' balances
    const own = await callerAs("u-other").balancesByLocation({ locationId: otherLocationId });
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r) => r.location_id === otherLocationId)).toBe(true);
  });
});
