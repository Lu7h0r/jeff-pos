import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { stationRentalsRouter } = await import("../station-rentals");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(stationRentalsRouter);
const callerAs = (uid: string, businessId: number | null = null) =>
  factory(makeContext(uid, { businessId }));

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let otherLocationId: number;
let pmCashId: number;
let pmTransferId: number;
let openSessionId: number;
let wsCabina1Id: number;
let wsCabina2Id: number;
let wsOtherId: number;
let staffSampleId: number;
let staffOtherId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff-rent@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-rent@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-rent" },
      { name: "Other Studio", slug: "other-rent" },
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

  const wsRows = await db
    .insert(schema.workstations)
    .values([
      { business_id: bizJeffId, location_id: amparoId, name: "Cabina 1", kind: "tattoo" },
      { business_id: bizJeffId, location_id: amparoId, name: "Cabina 2", kind: "tattoo" },
      { business_id: bizOtherId, location_id: otherLocationId, name: "OtherWS", kind: "general" },
    ])
    .returning();
  wsCabina1Id = wsRows[0].id;
  wsCabina2Id = wsRows[1].id;
  wsOtherId = wsRows[2].id;

  const staffRows = await db
    .insert(schema.staffMembers)
    .values([
      { business_id: bizJeffId, display_name: "Sample Artist" },
      { business_id: bizOtherId, display_name: "Other Artist" },
    ])
    .returning();
  staffSampleId = staffRows[0].id;
  staffOtherId = staffRows[1].id;
});

afterAll(async () => {
  await pg.close();
});

const baseDay = new Date(2026, 3, 1, 0, 0, 0);
const at = (h: number, m = 0) =>
  new Date(2026, 3, 1, h, m, 0);

describe("stationRentals.create", () => {
  it("creates a scheduled rental", async () => {
    const r = await callerAs("u-jeff", bizJeffId).create({
      workstationId: wsCabina1Id,
      staffMemberId: staffSampleId,
      startAt: at(10),
      endAt: at(12),
      amount: 50_000,
    });
    expect(r.business_id).toBe(bizJeffId);
    expect(r.status).toBe("scheduled");
    expect(r.amount).toBe(50_000);
  });

  it("rejects overlapping schedule on same workstation (CONFLICT)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).create({
        workstationId: wsCabina1Id,
        staffMemberId: staffSampleId,
        startAt: at(11),
        endAt: at(13),
        amount: 30_000,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });

  it("allows back-to-back non-overlapping rentals on same workstation", async () => {
    const r = await callerAs("u-jeff", bizJeffId).create({
      workstationId: wsCabina1Id,
      staffMemberId: staffSampleId,
      startAt: at(12),
      endAt: at(14),
      amount: 30_000,
    });
    expect(r.id).toBeGreaterThan(0);
  });

  it("allows overlapping rentals on different workstations", async () => {
    const r = await callerAs("u-jeff", bizJeffId).create({
      workstationId: wsCabina2Id,
      staffMemberId: staffSampleId,
      startAt: at(10),
      endAt: at(12),
      amount: 40_000,
    });
    expect(r.id).toBeGreaterThan(0);
  });

  it("writes cash_movement (manual_in, positive) when paid in cash from open session", async () => {
    const [sessionBefore] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, openSessionId));
    const expectedBefore = sessionBefore.expected_cash_amount;

    const r = await callerAs("u-jeff", bizJeffId).create({
      workstationId: wsCabina2Id,
      staffMemberId: staffSampleId,
      startAt: at(15),
      endAt: at(17),
      amount: 60_000,
      paymentMethodId: pmCashId,
      cashSessionId: openSessionId,
    });

    const movements = await db
      .select()
      .from(schema.cashMovements)
      .where(
        and(
          eq(schema.cashMovements.source_type, "station_rental"),
          eq(schema.cashMovements.source_id, r.id),
        ),
      );
    expect(movements.length).toBe(1);
    expect(movements[0].amount).toBe(60_000);
    expect(movements[0].type).toBe("manual_in");
    expect(movements[0].transaction_type).toBe("positive");

    const [sessionAfter] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, openSessionId));
    expect(sessionAfter.expected_cash_amount).toBe(expectedBefore + 60_000);
  });

  it("does NOT write cash_movement when payment method is non-cash", async () => {
    const r = await callerAs("u-jeff", bizJeffId).create({
      workstationId: wsCabina2Id,
      staffMemberId: staffSampleId,
      startAt: at(18),
      endAt: at(20),
      amount: 60_000,
      paymentMethodId: pmTransferId,
      cashSessionId: openSessionId,
    });
    const movements = await db
      .select()
      .from(schema.cashMovements)
      .where(
        and(
          eq(schema.cashMovements.source_type, "station_rental"),
          eq(schema.cashMovements.source_id, r.id),
        ),
      );
    expect(movements.length).toBe(0);
  });

  it("rejects when workstation belongs to another business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).create({
        workstationId: wsOtherId,
        staffMemberId: staffSampleId,
        startAt: at(8),
        endAt: at(9),
        amount: 10_000,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("rejects when staff belongs to another business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).create({
        workstationId: wsCabina1Id,
        staffMemberId: staffOtherId,
        startAt: at(8),
        endAt: at(9),
        amount: 10_000,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("stationRentals.markCompleted / cancel / list", () => {
  it("markCompleted sets status=completed", async () => {
    const r = await callerAs("u-jeff", bizJeffId).create({
      workstationId: wsCabina2Id,
      staffMemberId: staffSampleId,
      startAt: at(21),
      endAt: at(22),
      amount: 10_000,
    });
    const updated = await callerAs("u-jeff", bizJeffId).markCompleted({
      id: r.id,
    });
    expect(updated.status).toBe("completed");
  });

  it("cancel reverses cash_movement when applicable", async () => {
    const [sessionBefore] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, openSessionId));
    const expectedBefore = sessionBefore.expected_cash_amount;

    const r = await callerAs("u-jeff", bizJeffId).create({
      workstationId: wsCabina2Id,
      staffMemberId: staffSampleId,
      startAt: new Date(2026, 3, 2, 10),
      endAt: new Date(2026, 3, 2, 12),
      amount: 25_000,
      paymentMethodId: pmCashId,
      cashSessionId: openSessionId,
    });

    const cancelled = await callerAs("u-jeff", bizJeffId).cancel({
      id: r.id,
      reason: "no-show",
    });
    expect(cancelled.status).toBe("cancelled");

    const reversal = await db
      .select()
      .from(schema.cashMovements)
      .where(
        and(
          eq(schema.cashMovements.source_type, "station_rental_cancel"),
          eq(schema.cashMovements.source_id, r.id),
        ),
      );
    expect(reversal.length).toBe(1);
    expect(reversal[0].amount).toBe(-25_000);
    expect(reversal[0].type).toBe("manual_out");

    const [sessionAfter] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, openSessionId));
    expect(sessionAfter.expected_cash_amount).toBe(expectedBefore);
  });

  it("list filters by date range", async () => {
    const list = await callerAs("u-jeff", bizJeffId).list({
      rangeFrom: baseDay,
      rangeTo: new Date(2026, 3, 1, 23, 59, 59),
    });
    expect(list.length).toBeGreaterThan(0);
    expect(
      list.every(
        (r) => r.start_at >= baseDay && r.start_at <= new Date(2026, 3, 2, 0),
      ),
    ).toBe(true);
  });
});
