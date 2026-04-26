import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { cashSessionsRouter } = await import("../cash-sessions");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const caller = createCallerFactory(cashSessionsRouter);
const callerAs = (uid: string) => caller({ user: makeUser(uid) });

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let britaliaId: number;
let otherLocationId: number;

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
});

afterAll(async () => {
  await pg.close();
});

describe("cashSessions.open", () => {
  it("creates an open session for an active member", async () => {
    const session = await callerAs("u-jeff").open({
      locationId: amparoId,
      openingCashAmount: 50_000,
      notes: "morning",
    });

    expect(session.id).toBeGreaterThan(0);
    expect(session.business_id).toBe(bizJeffId);
    expect(session.location_id).toBe(amparoId);
    expect(session.opened_by_user_id).toBe("u-jeff");
    expect(session.opening_cash_amount).toBe(50_000);
    expect(session.expected_cash_amount).toBe(50_000);
    expect(session.expected_digital_amount).toBe(0);
    expect(session.status).toBe("open");
    expect(session.notes).toBe("morning");
  });

  it("rejects users without membership in the location's business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-other").open({ locationId: amparoId, openingCashAmount: 0 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    await expect(
      callerAs("u-orphan").open({ locationId: amparoId, openingCashAmount: 0 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("rejects opening when there is already an open session for the same location (CONFLICT)", async () => {
    await expect(
      callerAs("u-jeff").open({ locationId: amparoId, openingCashAmount: 1_000 }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });
});

describe("cashSessions.current", () => {
  it("returns the open session for a location", async () => {
    const current = await callerAs("u-jeff").current({ locationId: amparoId });
    expect(current).not.toBeNull();
    expect(current!.location_id).toBe(amparoId);
    expect(current!.status).toBe("open");
  });

  it("returns null when no session is open for that location", async () => {
    const current = await callerAs("u-jeff").current({ locationId: britaliaId });
    expect(current).toBeNull();
  });

  it("rejects users with no membership in the location's business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-orphan").current({ locationId: amparoId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    await expect(
      callerAs("u-other").current({ locationId: amparoId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("cashSessions.close", () => {
  it("closes an open session, sets counted, difference and closed_at", async () => {
    const open = await callerAs("u-jeff").open({
      locationId: britaliaId,
      openingCashAmount: 30_000,
    });

    const closed = await callerAs("u-jeff").close({
      cashSessionId: open.id,
      countedCashAmount: 31_500,
      notes: "off by 1500",
    });

    expect(closed.status).toBe("closed");
    expect(closed.counted_cash_amount).toBe(31_500);
    expect(closed.difference_amount).toBe(1_500);
    expect(closed.closed_by_user_id).toBe("u-jeff");
    expect(closed.closed_at).not.toBeNull();
    expect(closed.notes).toBe("off by 1500");
  });

  it("computes difference correctly when counted < expected (negative)", async () => {
    const open = await callerAs("u-jeff").open({
      locationId: britaliaId,
      openingCashAmount: 20_000,
    });

    const closed = await callerAs("u-jeff").close({
      cashSessionId: open.id,
      countedCashAmount: 18_500,
    });

    expect(closed.difference_amount).toBe(-1_500);
  });

  it("rejects closing an already-closed session (CONFLICT)", async () => {
    const open = await callerAs("u-jeff").open({
      locationId: britaliaId,
      openingCashAmount: 10_000,
    });

    await callerAs("u-jeff").close({
      cashSessionId: open.id,
      countedCashAmount: 10_000,
    });

    await expect(
      callerAs("u-jeff").close({
        cashSessionId: open.id,
        countedCashAmount: 10_000,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });
});

describe("cashSessions cross-location isolation", () => {
  it("two locations of the same business can have independent open sessions", async () => {
    // Amparo already has an open session from earlier tests. Britalia's last
    // session was closed; open a fresh one and assert both coexist.
    const britaliaOpen = await callerAs("u-jeff").open({
      locationId: britaliaId,
      openingCashAmount: 5_000,
    });

    const amparoCurrent = await callerAs("u-jeff").current({ locationId: amparoId });
    const britaliaCurrent = await callerAs("u-jeff").current({ locationId: britaliaId });

    expect(amparoCurrent).not.toBeNull();
    expect(britaliaCurrent).not.toBeNull();
    expect(amparoCurrent!.location_id).toBe(amparoId);
    expect(britaliaCurrent!.id).toBe(britaliaOpen.id);
    expect(britaliaCurrent!.location_id).toBe(britaliaId);
    expect(amparoCurrent!.id).not.toBe(britaliaCurrent!.id);
  });
});
