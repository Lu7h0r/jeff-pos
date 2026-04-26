import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { eq, and, desc } from "drizzle-orm";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { expensesRouter } = await import("../expenses");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(expensesRouter);
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
let closedSessionId: number;
let otherBizSessionId: number;
let arriendoCatId: number;
let serviciosCatId: number;
let otherBizCatId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff-exp@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-exp@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-exp" },
      { name: "Other Studio", slug: "other-exp" },
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

  const sessions = await db
    .insert(schema.cashSessions)
    .values([
      {
        business_id: bizJeffId,
        location_id: amparoId,
        opened_by_user_id: "u-jeff",
        opening_cash_amount: 100_000,
        expected_cash_amount: 100_000,
        expected_digital_amount: 0,
        status: "open",
      },
      {
        business_id: bizJeffId,
        location_id: britaliaId,
        opened_by_user_id: "u-jeff",
        opening_cash_amount: 0,
        expected_cash_amount: 0,
        expected_digital_amount: 0,
        status: "closed",
        closed_by_user_id: "u-jeff",
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
  openSessionId = sessions[0].id;
  closedSessionId = sessions[1].id;
  otherBizSessionId = sessions[2].id;

  const cats = await db
    .insert(schema.expenseCategories)
    .values([
      { business_id: bizJeffId, name: "Arriendo" },
      { business_id: bizJeffId, name: "Servicios" },
      { business_id: bizOtherId, name: "OtherCat" },
    ])
    .returning();
  arriendoCatId = cats[0].id;
  serviciosCatId = cats[1].id;
  otherBizCatId = cats[2].id;
});

afterAll(async () => {
  await pg.close();
});

describe("expenses.categories", () => {
  it("create + list scoped by active business", async () => {
    const created = await callerAs("u-jeff", bizJeffId).categories.create({
      name: "Marketing",
      kind: "recurring",
    });
    expect(created.business_id).toBe(bizJeffId);
    expect(created.name).toBe("Marketing");
    expect(created.kind).toBe("recurring");

    const list = await callerAs("u-jeff", bizJeffId).categories.list();
    const names = list.map((c) => c.name);
    expect(names).toContain("Marketing");
    expect(names).toContain("Arriendo");
    expect(list.every((c) => c.business_id === bizJeffId)).toBe(true);
  });

  it("rejects without active business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", null).categories.create({ name: "Nope" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("cross-business isolation: bizOther never sees bizJeff categories", async () => {
    const list = await callerAs("u-other", bizOtherId).categories.list();
    expect(list.every((c) => c.business_id === bizOtherId)).toBe(true);
    expect(list.some((c) => c.id === arriendoCatId)).toBe(false);
  });
});

describe("expenses.entries.create", () => {
  it("persists with active business and location", async () => {
    const entry = await callerAs("u-jeff", bizJeffId).entries.create({
      categoryId: arriendoCatId,
      amount: 1_430_000_00,
      incurredAt: new Date("2026-01-15"),
      locationId: amparoId,
      description: "Arriendo enero",
    });
    expect(entry.business_id).toBe(bizJeffId);
    expect(entry.location_id).toBe(amparoId);
    expect(entry.amount).toBe(1_430_000_00);
    expect(entry.created_by_user_id).toBe("u-jeff");
  });

  it("writes cash_movement when paid in cash from open session", async () => {
    const [sessionBefore] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, openSessionId));
    const expectedBefore = sessionBefore.expected_cash_amount;

    const entry = await callerAs("u-jeff", bizJeffId).entries.create({
      categoryId: serviciosCatId,
      amount: 25_000_00,
      incurredAt: new Date("2026-01-20"),
      locationId: amparoId,
      paymentMethodId: pmCashId,
      cashSessionId: openSessionId,
      description: "Servicios pagados en caja",
    });

    const movements = await db
      .select()
      .from(schema.cashMovements)
      .where(
        and(
          eq(schema.cashMovements.source_type, "expense"),
          eq(schema.cashMovements.source_id, entry.id),
        ),
      );
    expect(movements.length).toBe(1);
    const mv = movements[0];
    expect(mv.amount).toBe(-25_000_00);
    expect(mv.type).toBe("manual_out");
    expect(mv.transaction_type).toBe("negative");
    expect(mv.balance_after).toBe(mv.balance_before - 25_000_00);

    const [sessionAfter] = await db
      .select()
      .from(schema.cashSessions)
      .where(eq(schema.cashSessions.id, openSessionId));
    expect(sessionAfter.expected_cash_amount).toBe(expectedBefore - 25_000_00);
  });

  it("does NOT write cash_movement when payment method is non-cash", async () => {
    const entry = await callerAs("u-jeff", bizJeffId).entries.create({
      categoryId: serviciosCatId,
      amount: 10_000_00,
      incurredAt: new Date("2026-01-21"),
      locationId: amparoId,
      paymentMethodId: pmTransferId,
      cashSessionId: openSessionId,
    });
    const movements = await db
      .select()
      .from(schema.cashMovements)
      .where(
        and(
          eq(schema.cashMovements.source_type, "expense"),
          eq(schema.cashMovements.source_id, entry.id),
        ),
      );
    expect(movements.length).toBe(0);
  });

  it("rejects category from another business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).entries.create({
        categoryId: otherBizCatId,
        amount: 1000,
        incurredAt: new Date(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("rejects cashSessionId from another business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).entries.create({
        categoryId: arriendoCatId,
        amount: 1000,
        incurredAt: new Date(),
        locationId: amparoId,
        paymentMethodId: pmCashId,
        cashSessionId: otherBizSessionId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("rejects when cashSessionId is closed (CONFLICT)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).entries.create({
        categoryId: arriendoCatId,
        amount: 1000,
        incurredAt: new Date(),
        locationId: britaliaId,
        paymentMethodId: pmCashId,
        cashSessionId: closedSessionId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });
});

describe("expenses.entries.list", () => {
  it("filters by location and date range", async () => {
    const all = await callerAs("u-jeff", bizJeffId).entries.list({});
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => r.business_id === bizJeffId)).toBe(true);

    const filteredByLoc = await callerAs("u-jeff", bizJeffId).entries.list({
      locationId: amparoId,
    });
    expect(filteredByLoc.every((r) => r.location_id === amparoId)).toBe(true);

    const filteredByRange = await callerAs("u-jeff", bizJeffId).entries.list({
      rangeFrom: new Date("2026-01-19"),
      rangeTo: new Date("2026-01-22"),
    });
    expect(filteredByRange.length).toBeGreaterThan(0);
    expect(
      filteredByRange.every(
        (r) =>
          r.incurred_at >= new Date("2026-01-19") &&
          r.incurred_at <= new Date("2026-01-22"),
      ),
    ).toBe(true);
  });
});

describe("expenses cross-business isolation", () => {
  it("u-other never sees bizJeff entries via list()", async () => {
    const list = await callerAs("u-other", bizOtherId).entries.list({});
    expect(list.every((r) => r.business_id === bizOtherId)).toBe(true);
  });
});

// suppress unused warning for desc which we don't use in this file
void desc;
