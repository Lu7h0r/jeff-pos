import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { businessesRouter } = await import("../businesses");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const caller = createCallerFactory(businessesRouter);
const callerAs = (uid: string) => caller({ user: makeUser(uid) });

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  // Seed: two businesses, two users with one membership each
  await db.insert(schema.user).values([
    {
      id: "u-jeff",
      name: "Jeff",
      email: "jeff@test.com",
      emailVerified: false,
      image: null,
    },
    {
      id: "u-other",
      name: "Other",
      email: "other@test.com",
      emailVerified: false,
      image: null,
    },
    {
      id: "u-orphan",
      name: "Orphan",
      email: "orphan@test.com",
      emailVerified: false,
      image: null,
    },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff" },
      { name: "Other Studio", slug: "other" },
    ])
    .returning();

  await db.insert(schema.businessMembers).values([
    {
      business_id: bizJeff.id,
      user_id: "u-jeff",
      role: "owner",
      status: "active",
    },
    {
      business_id: bizOther.id,
      user_id: "u-other",
      role: "owner",
      status: "active",
    },
  ]);
});

afterAll(async () => {
  await pg.close();
});

describe("businesses.getCurrent", () => {
  it("returns business and role for an active member", async () => {
    const result = await callerAs("u-jeff").getCurrent();
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("jeff");
    expect(result!.name).toBe("Jeff Studio");
    expect(result!.role).toBe("owner");
  });

  it("returns null for a user with no membership", async () => {
    const result = await callerAs("u-orphan").getCurrent();
    expect(result).toBeNull();
  });

  it("isolates businesses across users — u-jeff never sees Other Studio", async () => {
    const result = await callerAs("u-jeff").getCurrent();
    expect(result!.slug).not.toBe("other");
    expect(result!.slug).toBe("jeff");
  });
});
