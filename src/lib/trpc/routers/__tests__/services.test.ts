import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { servicesRouter } = await import("../services");
const { computeShares } = await import("../../commission-split");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(servicesRouter);
const callerAs = (uid: string, businessId: number | null = null) =>
  factory(makeContext(uid, { businessId }));

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let otherLocationId: number;
let openSessionId: number;
let otherSessionId: number;
let staffJeff30Id: number;
let staffJeff50Id: number;
let staffJeff70Id: number;
let staffJeffOwnerId: number;
let staffJeffManualId: number;
let staffOtherId: number;
let orderItemJeffId: number;
let orderItemJeffSecondaryId: number;
let orderItemOtherId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff-svc@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-svc@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-svc" },
      { name: "Other Studio", slug: "other-svc" },
    ])
    .returning();
  bizJeffId = bizJeff.id;
  bizOtherId = bizOther.id;

  const locs = await db
    .insert(schema.locations)
    .values([
      { business_id: bizJeffId, name: "Amparo", slug: "amparo" },
      { business_id: bizOtherId, name: "Other", slug: "other-loc" },
    ])
    .returning();
  amparoId = locs[0].id;
  otherLocationId = locs[1].id;

  const [sessJeff, sessOther] = await db
    .insert(schema.cashSessions)
    .values([
      {
        business_id: bizJeffId,
        location_id: amparoId,
        opened_by_user_id: "u-jeff",
        opening_cash_amount: 0,
        expected_cash_amount: 0,
        expected_digital_amount: 0,
        status: "open",
      },
      {
        business_id: bizOtherId,
        location_id: otherLocationId,
        opened_by_user_id: "u-other",
        opening_cash_amount: 0,
        expected_cash_amount: 0,
        expected_digital_amount: 0,
        status: "open",
      },
    ])
    .returning();
  openSessionId = sessJeff.id;
  otherSessionId = sessOther.id;

  const staffRows = await db
    .insert(schema.staffMembers)
    .values([
      { business_id: bizJeffId, display_name: "Artist 30/70", default_split: "staff_30_house_70" },
      { business_id: bizJeffId, display_name: "Artist 50/50", default_split: "staff_50_house_50" },
      { business_id: bizJeffId, display_name: "Artist 70/30", default_split: "staff_70_house_30" },
      { business_id: bizJeffId, display_name: "Owner direct", default_split: "owner_direct" },
      { business_id: bizJeffId, display_name: "Manual split", default_split: "manual" },
      { business_id: bizOtherId, display_name: "Other Artist", default_split: "staff_30_house_70" },
    ])
    .returning();
  staffJeff30Id = staffRows[0].id;
  staffJeff50Id = staffRows[1].id;
  staffJeff70Id = staffRows[2].id;
  staffJeffOwnerId = staffRows[3].id;
  staffJeffManualId = staffRows[4].id;
  staffOtherId = staffRows[5].id;

  const [orderJeff] = await db
    .insert(schema.orders)
    .values({
      total_amount: 200_000,
      user_uid: "u-jeff",
      business_id: bizJeffId,
      location_id: amparoId,
      cash_session_id: openSessionId,
      payment_status: "paid",
      process_status: "complete",
    })
    .returning();

  const [orderOther] = await db
    .insert(schema.orders)
    .values({
      total_amount: 100_000,
      user_uid: "u-other",
      business_id: bizOtherId,
      location_id: otherLocationId,
      cash_session_id: otherSessionId,
      payment_status: "paid",
      process_status: "complete",
    })
    .returning();

  const itemRows = await db
    .insert(schema.orderItems)
    .values([
      {
        order_id: orderJeff.id,
        product_id: null,
        quantity: 1,
        price: 200_000,
        product_name: "Tatuaje brazo",
        unit_price: 200_000,
        unit_cost: null,
        total_price: 200_000,
      },
      {
        order_id: orderJeff.id,
        product_id: null,
        quantity: 1,
        price: 150_001,
        product_name: "Tatuaje espalda",
        unit_price: 150_001,
        unit_cost: null,
        total_price: 150_001,
      },
      {
        order_id: orderOther.id,
        product_id: null,
        quantity: 1,
        price: 100_000,
        product_name: "Other tatuaje",
        unit_price: 100_000,
        unit_cost: null,
        total_price: 100_000,
      },
    ])
    .returning();
  orderItemJeffId = itemRows[0].id;
  orderItemJeffSecondaryId = itemRows[1].id;
  orderItemOtherId = itemRows[2].id;
});

afterAll(async () => {
  await pg.close();
});

describe("services.attachToOrderItem", () => {
  // TODO(fase-1): pending-balance calculations for services with abonos are
  // blocked by missing order-level incremental collection flow in ordersRouter
  // (today create enforces sum(paymentLines) === total and always persists paid).
  // When abonos exist, add integration coverage here for saldo_pendiente based
  // on service-linked order totals minus cumulative order_payments.
  it("creates service_sale + commission_estimate with snapshot split (30/70)", async () => {
    const r = await callerAs("u-jeff", bizJeffId).attachToOrderItem({
      orderItemId: orderItemJeffId,
      staffMemberId: staffJeff30Id,
      serviceKind: "tattoo",
      bodyLocation: "brazo derecho",
    });
    expect(r.serviceSale.commission_split).toBe("staff_30_house_70");
    expect(r.commissionEstimate.gross_amount).toBe(200_000);
    expect(r.commissionEstimate.staff_share_amount).toBe(60_000);
    expect(r.commissionEstimate.house_share_amount).toBe(140_000);
    expect(r.commissionEstimate.split_kind).toBe("staff_30_house_70");
    expect(r.commissionEstimate.status).toBe("estimated");
  });

  it("computes shares for each split kind (50/50, 70/30, owner_direct, manual) — pure helper", () => {
    expect(computeShares(200_000, "staff_30_house_70")).toEqual({
      staff: 60_000,
      house: 140_000,
    });
    expect(computeShares(200_000, "staff_50_house_50")).toEqual({
      staff: 100_000,
      house: 100_000,
    });
    expect(computeShares(200_000, "staff_70_house_30")).toEqual({
      staff: 140_000,
      house: 60_000,
    });
    expect(computeShares(200_000, "owner_direct")).toEqual({
      staff: 0,
      house: 200_000,
    });
    expect(computeShares(200_000, "manual")).toEqual({ staff: 0, house: 0 });
    // House gets the cent-level remainder when staff share rounds down.
    expect(computeShares(150_001, "staff_50_house_50")).toEqual({
      staff: 75_000,
      house: 75_001,
    });
  });

  it("attaches with owner_direct yielding staff=0 and full house share", async () => {
    const r = await callerAs("u-jeff", bizJeffId).attachToOrderItem({
      orderItemId: orderItemJeffSecondaryId,
      staffMemberId: staffJeffOwnerId,
      serviceKind: "tattoo",
    });
    expect(r.commissionEstimate.staff_share_amount).toBe(0);
    expect(r.commissionEstimate.house_share_amount).toBe(150_001);
  });

  it("rejects when order_item belongs to another business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).attachToOrderItem({
        orderItemId: orderItemOtherId,
        staffMemberId: staffJeff30Id,
        serviceKind: "tattoo",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("rejects when staff belongs to another business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).attachToOrderItem({
        orderItemId: orderItemJeffId,
        staffMemberId: staffOtherId,
        serviceKind: "tattoo",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("services.list", () => {
  it("joins with order_items + orders + staff and returns enriched rows", async () => {
    const list = await callerAs("u-jeff", bizJeffId).list({});
    expect(list.length).toBeGreaterThan(0);
    const row = list[0];
    expect(row.staff_display_name).toBeDefined();
    expect(row.product_name).toBeDefined();
    expect(row.order_business_id).toBe(bizJeffId);
  });

  it("filters by staffMemberId", async () => {
    const list = await callerAs("u-jeff", bizJeffId).list({
      staffMemberId: staffJeff30Id,
    });
    expect(list.every((r) => r.staff_member_id === staffJeff30Id)).toBe(true);
  });
});

describe("services.commissions", () => {
  it("list filters by staff and returns running totals per staff", async () => {
    // Add an extra estimate for staffJeff50Id so we have multiple rows.
    await callerAs("u-jeff", bizJeffId).attachToOrderItem({
      orderItemId: orderItemJeffId,
      staffMemberId: staffJeff50Id,
      serviceKind: "tattoo",
    });

    const list50 = await callerAs("u-jeff", bizJeffId).commissions.list({
      staffMemberId: staffJeff50Id,
    });
    expect(list50.length).toBeGreaterThan(0);
    expect(list50.every((r) => r.staff_member_id === staffJeff50Id)).toBe(true);

    // Running total grows monotonically per staff in order of ids.
    const all = await callerAs("u-jeff", bizJeffId).commissions.list({});
    let runningByStaff = new Map<number, number>();
    for (const row of all) {
      const prev = runningByStaff.get(row.staff_member_id) ?? 0;
      const expected = prev + row.staff_share_amount;
      expect(row.staff_running_total).toBe(expected);
      runningByStaff.set(row.staff_member_id, expected);
    }
  });

  it("filters by status", async () => {
    const all = await callerAs("u-jeff", bizJeffId).commissions.list({
      status: "estimated",
    });
    expect(all.every((r) => r.status === "estimated")).toBe(true);
  });

  it("markLiquidated updates status, liquidated_at and liquidated_by_user_id", async () => {
    // Pick the first estimated commission for bizJeff
    const all = await callerAs("u-jeff", bizJeffId).commissions.list({
      status: "estimated",
    });
    const target = all[0];
    const updated = await callerAs("u-jeff", bizJeffId).commissions.markLiquidated({
      commissionEstimateId: target.id,
      notes: "paid in cash",
    });
    expect(updated.status).toBe("liquidated");
    expect(updated.liquidated_at).not.toBeNull();
    expect(updated.liquidated_by_user_id).toBe("u-jeff");
  });

  it("rejects markLiquidated on already-liquidated (CONFLICT)", async () => {
    const liquidated = await db
      .select()
      .from(schema.commissionEstimates)
      .where(eq(schema.commissionEstimates.status, "liquidated"))
      .limit(1);
    expect(liquidated.length).toBeGreaterThan(0);
    await expect(
      callerAs("u-jeff", bizJeffId).commissions.markLiquidated({
        commissionEstimateId: liquidated[0].id,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });

  it("cross-business isolation: bizOther cannot list or liquidate bizJeff estimates", async () => {
    const otherList = await callerAs("u-other", bizOtherId).commissions.list({});
    expect(otherList.every((r) => r.business_id === bizOtherId)).toBe(true);

    const [jeffEstimate] = await db
      .select()
      .from(schema.commissionEstimates)
      .where(eq(schema.commissionEstimates.business_id, bizJeffId))
      .limit(1);
    await expect(
      callerAs("u-other", bizOtherId).commissions.markLiquidated({
        commissionEstimateId: jeffEstimate.id,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});
