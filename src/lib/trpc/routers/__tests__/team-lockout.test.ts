import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

// Better Auth stub — team.archive does not call signUpEmail but the team
// router imports `auth`, so we stub it for module resolution.
const auth = { api: { signUpEmail: async () => ({ user: { id: "x" } }) } };
mock.module("@/lib/auth", () => ({ auth }));

const { teamRouter } = await import("../team");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(teamRouter);

let bizAId: number;
let bizBId: number;
let bizAOwner1: number;
let bizAOwner2: number;
let bizASecondOwner: number;
let bizASoloOwner: number;
let bizAManager: number;
let bizACashier: number;
let bizASuspendedOwnerId: number;
let bizBOwner: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-a-owner1", name: "A1", email: "a1@t.com", emailVerified: false, image: null },
    { id: "u-a-owner2", name: "A2", email: "a2@t.com", emailVerified: false, image: null },
    { id: "u-a-second", name: "AS", email: "as@t.com", emailVerified: false, image: null },
    { id: "u-a-solo", name: "ASO", email: "aso@t.com", emailVerified: false, image: null },
    { id: "u-a-manager", name: "AM", email: "am@t.com", emailVerified: false, image: null },
    { id: "u-a-cashier", name: "AC", email: "ac@t.com", emailVerified: false, image: null },
    { id: "u-a-suspended", name: "ASU", email: "asu@t.com", emailVerified: false, image: null },
    { id: "u-b-owner", name: "B1", email: "b1@t.com", emailVerified: false, image: null },
  ]);

  const [bizA, bizB] = await db
    .insert(schema.businesses)
    .values([
      { name: "Biz A", slug: "lockout-a" },
      { name: "Biz B", slug: "lockout-b" },
    ])
    .returning();
  bizAId = bizA.id;
  bizBId = bizB.id;

  // Biz A: two active owners (so we can archive one), one extra owner used
  // by the "becomes the last owner" scenario, one suspended owner (must
  // not count toward the active-owner count), plus a manager and cashier.
  // u-a-solo is owner of a *separate* biz path: we only attach them after
  // we want a single-owner business — so we skip them initially and only
  // add the lone owner inside that test setup.
  const memberships = await db
    .insert(schema.businessMembers)
    .values([
      { business_id: bizAId, user_id: "u-a-owner1", role: "owner", status: "active" },
      { business_id: bizAId, user_id: "u-a-owner2", role: "owner", status: "active" },
      { business_id: bizAId, user_id: "u-a-second", role: "owner", status: "active" },
      { business_id: bizAId, user_id: "u-a-manager", role: "manager", status: "active" },
      { business_id: bizAId, user_id: "u-a-cashier", role: "cashier", status: "active" },
      { business_id: bizAId, user_id: "u-a-suspended", role: "owner", status: "suspended" },
      { business_id: bizBId, user_id: "u-b-owner", role: "owner", status: "active" },
    ])
    .returning();
  bizAOwner1 = memberships[0].id;
  bizAOwner2 = memberships[1].id;
  bizASecondOwner = memberships[2].id;
  bizAManager = memberships[3].id;
  bizACashier = memberships[4].id;
  bizASuspendedOwnerId = memberships[5].id;
  bizBOwner = memberships[6].id;

  // Biz A has u-a-solo as a separate location member (not owner). For the
  // "last-owner protection" test we attach a fresh single-owner business
  // with a unique row — see test below.
  const [_solo] = await db
    .insert(schema.businessMembers)
    .values([
      { business_id: bizBId, user_id: "u-a-solo", role: "owner", status: "active" },
    ])
    .returning();
  bizASoloOwner = _solo.id;
});

afterAll(async () => {
  await pg.close();
});

const callerForA = (uid: string) =>
  factory(makeContext(uid, { businessId: bizAId, role: "owner" }));
const callerForB = (uid: string) =>
  factory(makeContext(uid, { businessId: bizBId, role: "owner" }));

describe("team.archive — DA-24 last-owner lockout protection", () => {
  it("archives a non-last owner successfully", async () => {
    const result = await callerForA("u-a-owner1").archive({
      membershipId: bizAOwner1,
      type: "business",
    });
    expect(result.status).toBe("removed");
  });

  it("rejects archiving the last active owner with CONFLICT", async () => {
    // After the previous test, biz A has two active owners left:
    // bizAOwner2 + bizASecondOwner. Archive one — that succeeds and now
    // bizAOwner2 is the only remaining active owner. Attempting to archive
    // it must fail.
    await callerForA("u-a-owner2").archive({
      membershipId: bizASecondOwner,
      type: "business",
    });

    await expect(
      callerForA("u-a-owner2").archive({
        membershipId: bizAOwner2,
        type: "business",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });

  it("counts only ACTIVE owners — suspended/removed owners do not save the last active one", async () => {
    // bizAOwner2 is the only active owner of biz A; u-a-suspended is an
    // owner row but with status="suspended" so it must NOT count. Archive
    // attempt on bizAOwner2 still fails.
    await expect(
      callerForA("u-a-owner2").archive({
        membershipId: bizAOwner2,
        type: "business",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);

    // Sanity: the suspended row exists.
    const { eq } = await import("drizzle-orm");
    const [row] = await db
      .select()
      .from(schema.businessMembers)
      .where(eq(schema.businessMembers.id, bizASuspendedOwnerId));
    expect(row.status).toBe("suspended");
  });

  it("allows archiving a non-owner (manager / cashier) even when they are the last of their role", async () => {
    const archivedManager = await callerForA("u-a-owner2").archive({
      membershipId: bizAManager,
      type: "business",
    });
    expect(archivedManager.status).toBe("removed");

    const archivedCashier = await callerForA("u-a-owner2").archive({
      membershipId: bizACashier,
      type: "business",
    });
    expect(archivedCashier.status).toBe("removed");
  });

  it("rule is per-business — archiving owner of biz B does not look at biz A's owners", async () => {
    // Biz B has two active owners: u-b-owner and u-a-solo. We can archive
    // one without lockout protection firing because the OTHER stays.
    const archived = await callerForB("u-b-owner").archive({
      membershipId: bizASoloOwner,
      type: "business",
    });
    expect(archived.status).toBe("removed");

    // And now u-b-owner becomes the last active owner of biz B; the rule
    // applies *per-business*, so archiving u-b-owner must be rejected even
    // though biz A still has its own (different) last owner alive.
    await expect(
      callerForB("u-b-owner").archive({
        membershipId: bizBOwner,
        type: "business",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" } satisfies Partial<TRPCError>);
  });
});
