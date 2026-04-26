import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, makeUser, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { locationsRouter } = await import("../locations");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const caller = createCallerFactory(locationsRouter);
const callerAs = (uid: string) => caller({ user: makeUser(uid) });

let amparoId: number;
let britaliaId: number;
let otherLocationId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

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

  const inserted = await db
    .insert(schema.locations)
    .values([
      { business_id: bizJeff.id, name: "Amparo", slug: "amparo" },
      { business_id: bizJeff.id, name: "Britalia", slug: "britalia" },
      { business_id: bizOther.id, name: "Other Location", slug: "other-loc" },
      {
        business_id: bizJeff.id,
        name: "Archived Site",
        slug: "archived",
        status: "archived",
      },
    ])
    .returning();

  amparoId = inserted[0].id;
  britaliaId = inserted[1].id;
  otherLocationId = inserted[2].id;
});

afterAll(async () => {
  await pg.close();
});

describe("locations.list", () => {
  it("returns active locations for an active member", async () => {
    const list = await callerAs("u-jeff").list();
    const slugs = list.map((l) => l.slug).sort();
    expect(slugs).toEqual(["amparo", "britalia"]);
  });

  it("excludes archived locations", async () => {
    const list = await callerAs("u-jeff").list();
    expect(list.some((l) => l.slug === "archived")).toBe(false);
  });

  it("returns empty array for a user with no membership", async () => {
    const list = await callerAs("u-orphan").list();
    expect(list).toEqual([]);
  });

  it("isolates locations across businesses — u-jeff never sees Other Studio locations", async () => {
    const list = await callerAs("u-jeff").list();
    expect(list.some((l) => l.slug === "other-loc")).toBe(false);
    expect(list.some((l) => l.id === otherLocationId)).toBe(false);
  });
});

describe("locations.getActive", () => {
  it("returns the requested location when it belongs to the user's business", async () => {
    const result = await callerAs("u-jeff").getActive({ locationId: britaliaId });
    expect(result).not.toBeNull();
    expect(result!.slug).toBe("britalia");
  });

  it("rejects a locationId that belongs to another business", async () => {
    await expect(
      callerAs("u-jeff").getActive({ locationId: otherLocationId }),
    ).rejects.toThrow();
  });

  it("falls back to first location when no id is provided", async () => {
    const result = await callerAs("u-jeff").getActive({});
    expect(result).not.toBeNull();
    expect([amparoId, britaliaId]).toContain(result!.id);
  });

  it("returns null for a user with no membership when no id is provided", async () => {
    const result = await callerAs("u-orphan").getActive({});
    expect(result).toBeNull();
  });
});
