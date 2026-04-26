import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { locationMembersRouter } = await import("../location-members");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(locationMembersRouter);
const callerAs = (uid: string, businessId: number | null = null) =>
  factory(makeContext(uid, { businessId }));

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let britaliaId: number;
let otherLocationId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff-lm@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-lm@test.com", emailVerified: false, image: null },
    { id: "u-artist", name: "Artist", email: "artist-lm@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-lm" },
      { name: "Other Studio", slug: "other-lm" },
    ])
    .returning();
  bizJeffId = bizJeff.id;
  bizOtherId = bizOther.id;

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
});

afterAll(async () => {
  await pg.close();
});

describe("locationMembers CRUD", () => {
  it("adds a member with role=artist", async () => {
    const created = await callerAs("u-jeff", bizJeffId).add({
      locationId: amparoId,
      userId: "u-artist",
      role: "artist",
    });
    expect(created.business_id).toBe(bizJeffId);
    expect(created.location_id).toBe(amparoId);
    expect(created.user_id).toBe("u-artist");
    expect(created.role).toBe("artist");
    expect(created.status).toBe("active");
  });

  it("rejects when location belongs to another business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).add({
        locationId: otherLocationId,
        userId: "u-artist",
        role: "cashier",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("updates role", async () => {
    const created = await callerAs("u-jeff", bizJeffId).add({
      locationId: britaliaId,
      userId: "u-artist",
      role: "viewer",
    });
    const updated = await callerAs("u-jeff", bizJeffId).update({
      id: created.id,
      role: "manager",
    });
    expect(updated.role).toBe("manager");
  });

  it("remove sets status=removed (soft delete) and excludes from list()", async () => {
    const created = await callerAs("u-jeff", bizJeffId).add({
      locationId: amparoId,
      userId: "u-artist",
      role: "cashier",
    });
    const removed = await callerAs("u-jeff", bizJeffId).remove({
      id: created.id,
    });
    expect(removed.status).toBe("removed");

    const list = await callerAs("u-jeff", bizJeffId).list({});
    expect(list.some((m) => m.id === created.id)).toBe(false);
  });

  it("list filters out removed and is scoped to active business", async () => {
    await callerAs("u-other", bizOtherId).add({
      locationId: otherLocationId,
      userId: "u-other",
      role: "manager",
    });
    const jeffList = await callerAs("u-jeff", bizJeffId).list({});
    expect(jeffList.every((m) => m.business_id === bizJeffId)).toBe(true);
    expect(jeffList.every((m) => m.status !== "removed")).toBe(true);
  });
});
