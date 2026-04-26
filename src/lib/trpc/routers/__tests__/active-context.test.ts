import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { resolveActiveContext } = await import("../../active-context");
const schema = await import("@/lib/db/schema");

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let britaliaId: number;
let otherLocationId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-broad", name: "Broad", email: "broad@t.com", emailVerified: false, image: null },
    { id: "u-granular", name: "Granular", email: "granular@t.com", emailVerified: false, image: null },
    { id: "u-mixed", name: "Mixed", email: "mixed@t.com", emailVerified: false, image: null },
    { id: "u-orphan", name: "Orphan", email: "orphan-ctx@t.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-ctx@t.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "ctx-jeff" },
      { name: "Other Studio", slug: "ctx-other" },
    ])
    .returning();
  bizJeffId = bizJeff.id;
  bizOtherId = bizOther.id;

  const inserted = await db
    .insert(schema.locations)
    .values([
      { business_id: bizJeffId, name: "Amparo", slug: "ctx-amparo" },
      { business_id: bizJeffId, name: "Britalia", slug: "ctx-britalia" },
      { business_id: bizOtherId, name: "Other", slug: "ctx-other-loc" },
    ])
    .returning();
  amparoId = inserted[0].id;
  britaliaId = inserted[1].id;
  otherLocationId = inserted[2].id;

  await db.insert(schema.businessMembers).values([
    { business_id: bizJeffId, user_id: "u-broad", role: "owner", status: "active" },
    // Mixed user has BROAD membership in Jeff plus a granular row in Other —
    // resolver must prefer broad and ignore the location row entirely.
    { business_id: bizJeffId, user_id: "u-mixed", role: "manager", status: "active" },
  ]);

  await db.insert(schema.locationMembers).values([
    {
      business_id: bizJeffId,
      location_id: amparoId,
      user_id: "u-granular",
      role: "cashier",
      status: "active",
    },
    {
      business_id: bizOtherId,
      location_id: otherLocationId,
      user_id: "u-mixed",
      role: "cashier",
      status: "active",
    },
  ]);
});

afterAll(async () => {
  await pg.close();
});

describe("resolveActiveContext", () => {
  it("returns broad context for a business_members user", async () => {
    const ctx = await resolveActiveContext("u-broad");
    expect(ctx).not.toBeNull();
    expect(ctx!.businessId).toBe(bizJeffId);
    expect(ctx!.role).toBe("owner");
    expect(ctx!.isLocationScoped).toBe(false);
  });

  it("returns location-scoped context for a location_members-only user", async () => {
    const ctx = await resolveActiveContext("u-granular");
    expect(ctx).not.toBeNull();
    expect(ctx!.businessId).toBe(bizJeffId);
    expect(ctx!.role).toBe("cashier");
    expect(ctx!.isLocationScoped).toBe(true);
  });

  it("effectiveLocationIds includes all active locations for broad members", async () => {
    const ctx = await resolveActiveContext("u-broad");
    expect(ctx!.effectiveLocationIds.sort()).toEqual(
      [amparoId, britaliaId].sort(),
    );
  });

  it("effectiveLocationIds restricts to location_members rows for granular users", async () => {
    const ctx = await resolveActiveContext("u-granular");
    expect(ctx!.effectiveLocationIds).toEqual([amparoId]);
  });

  it("isLocationScoped is true for granular and false for broad", async () => {
    const broad = await resolveActiveContext("u-broad");
    const granular = await resolveActiveContext("u-granular");
    expect(broad!.isLocationScoped).toBe(false);
    expect(granular!.isLocationScoped).toBe(true);
  });

  it("honours cookieLocationId when in effectiveLocationIds, else falls back to first", async () => {
    const honoured = await resolveActiveContext("u-broad", britaliaId);
    expect(honoured!.locationId).toBe(britaliaId);

    const fallback = await resolveActiveContext("u-broad", otherLocationId);
    expect(fallback!.locationId).toBe(amparoId);
  });

  it("returns null for a user with no membership at all", async () => {
    const ctx = await resolveActiveContext("u-orphan");
    expect(ctx).toBeNull();
  });

  it("throws when location_members rows span multiple businesses (data integrity)", async () => {
    await db.insert(schema.user).values({
      id: "u-cross",
      name: "Cross",
      email: "cross-ctx@t.com",
      emailVerified: false,
      image: null,
    });
    await db.insert(schema.locationMembers).values([
      {
        business_id: bizJeffId,
        location_id: amparoId,
        user_id: "u-cross",
        role: "cashier",
        status: "active",
      },
      {
        business_id: bizOtherId,
        location_id: otherLocationId,
        user_id: "u-cross",
        role: "cashier",
        status: "active",
      },
    ]);

    await expect(resolveActiveContext("u-cross")).rejects.toThrow(
      /multiple businesses/,
    );
  });

  it("broad wins when a user has both broad and granular memberships", async () => {
    const ctx = await resolveActiveContext("u-mixed");
    expect(ctx).not.toBeNull();
    expect(ctx!.businessId).toBe(bizJeffId);
    expect(ctx!.isLocationScoped).toBe(false);
    expect(ctx!.role).toBe("manager");
  });
});
