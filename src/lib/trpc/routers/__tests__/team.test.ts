import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

// Mock Better Auth so team.invite can create new users without the full
// adapter wired against PGlite. Stub signUpEmail inserts a user row into the
// in-memory db; signInEmail recovers the row by email.
const auth = {
  api: {
    signUpEmail: async ({
      body,
    }: {
      body: { name: string; email: string; password: string };
    }) => {
      const id = `u-${body.email.replace(/[^a-z0-9]/gi, "-")}`;
      const schema = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const [existing] = await db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, body.email))
        .limit(1);
      if (existing) {
        throw new Error("user already exists");
      }
      const [created] = await db
        .insert(schema.user)
        .values({
          id,
          name: body.name,
          email: body.email,
          emailVerified: false,
          image: null,
        })
        .returning();
      return { user: created };
    },
  },
};
mock.module("@/lib/auth", () => ({ auth }));

const { teamRouter } = await import("../team");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(teamRouter);

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let britaliaId: number;
let otherLocationId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    {
      id: "u-jeff",
      name: "Jeff",
      email: "jeff-team@t.com",
      emailVerified: false,
      image: null,
    },
    {
      id: "u-cashier",
      name: "Existing Cashier",
      email: "existing-cashier@t.com",
      emailVerified: false,
      image: null,
    },
    {
      id: "u-other-owner",
      name: "Other Owner",
      email: "other-owner@t.com",
      emailVerified: false,
      image: null,
    },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "team-jeff" },
      { name: "Other Studio", slug: "team-other" },
    ])
    .returning();
  bizJeffId = bizJeff.id;
  bizOtherId = bizOther.id;

  const inserted = await db
    .insert(schema.locations)
    .values([
      { business_id: bizJeffId, name: "Amparo", slug: "team-amparo" },
      { business_id: bizJeffId, name: "Britalia", slug: "team-britalia" },
      { business_id: bizOtherId, name: "Other", slug: "team-other-loc" },
    ])
    .returning();
  amparoId = inserted[0].id;
  britaliaId = inserted[1].id;
  otherLocationId = inserted[2].id;

  await db.insert(schema.businessMembers).values([
    {
      business_id: bizJeffId,
      user_id: "u-jeff",
      role: "owner",
      status: "active",
    },
    {
      business_id: bizOtherId,
      user_id: "u-other-owner",
      role: "owner",
      status: "active",
    },
  ]);
});

afterAll(async () => {
  await pg.close();
});

const ownerCaller = () =>
  factory(makeContext("u-jeff", { businessId: bizJeffId, role: "owner" }));
const cashierCaller = () =>
  factory(makeContext("u-jeff", { businessId: bizJeffId, role: "cashier" }));
const otherOwnerCaller = () =>
  factory(
    makeContext("u-other-owner", {
      businessId: bizOtherId,
      role: "owner",
    }),
  );

describe("team.invite", () => {
  it("creates user + business membership when scope.kind = 'business'", async () => {
    const result = await ownerCaller().invite({
      email: "new-manager@t.com",
      displayName: "New Manager",
      role: "manager",
      scope: { kind: "business" },
    });
    expect(result.type).toBe("business");
    expect(result.role).toBe("manager");
    expect(result.locationId).toBeNull();
    expect(result.userId).toMatch(/u-new-manager/);
  });

  it("creates user + location membership when scope.kind = 'location'", async () => {
    const result = await ownerCaller().invite({
      email: "amparo-cashier@t.com",
      displayName: "Amparo Cashier",
      role: "cashier",
      scope: { kind: "location", locationId: amparoId },
    });
    expect(result.type).toBe("location");
    expect(result.role).toBe("cashier");
    expect(result.locationId).toBe(amparoId);
  });

  it("returns the password in response when caller did not provide one", async () => {
    const result = await ownerCaller().invite({
      email: "auto-pass@t.com",
      displayName: "Auto Pass",
      role: "viewer",
      scope: { kind: "business" },
    });
    expect(result.generatedPassword).not.toBeNull();
    expect(result.generatedPassword!.length).toBeGreaterThanOrEqual(12);
  });

  it("rejects FORBIDDEN when caller is a cashier (ownerOrManager guard)", async () => {
    await expect(
      cashierCaller().invite({
        email: "should-fail@t.com",
        displayName: "X",
        role: "cashier",
        scope: { kind: "business" },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("rejects when target location belongs to a different business", async () => {
    await expect(
      ownerCaller().invite({
        email: "wrong-loc@t.com",
        displayName: "Wrong Loc",
        role: "cashier",
        scope: { kind: "location", locationId: otherLocationId },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });
});

describe("team.list", () => {
  it("returns business + location members joined with user data", async () => {
    const list = await ownerCaller().list();
    const emails = list.map((m) => m.email).sort();
    expect(emails).toContain("new-manager@t.com");
    expect(emails).toContain("amparo-cashier@t.com");
    expect(emails).toContain("jeff-team@t.com");

    const granular = list.find((m) => m.email === "amparo-cashier@t.com")!;
    expect(granular.type).toBe("location");
    expect(granular.locationName).toBe("Amparo");
  });

  it("excludes archived (status='removed') memberships", async () => {
    const target = await ownerCaller().invite({
      email: "to-remove@t.com",
      displayName: "To Remove",
      role: "viewer",
      scope: { kind: "business" },
    });
    await ownerCaller().archive({
      membershipId: target.membershipId,
      type: "business",
    });
    const list = await ownerCaller().list();
    expect(list.some((m) => m.email === "to-remove@t.com")).toBe(false);
  });

  it("isolates across businesses — biz A list does not include biz B members", async () => {
    await otherOwnerCaller().invite({
      email: "other-cashier@t.com",
      displayName: "Other Cashier",
      role: "cashier",
      scope: { kind: "business" },
    });
    const jeffList = await ownerCaller().list();
    expect(jeffList.some((m) => m.email === "other-cashier@t.com")).toBe(false);
  });
});

describe("team.updateRole", () => {
  it("changes role on business_members", async () => {
    const created = await ownerCaller().invite({
      email: "promotable@t.com",
      displayName: "Promotable",
      role: "viewer",
      scope: { kind: "business" },
    });
    const updated = await ownerCaller().updateRole({
      membershipId: created.membershipId,
      type: "business",
      role: "manager",
    });
    expect(updated.role).toBe("manager");
  });

  it("changes role on location_members", async () => {
    const created = await ownerCaller().invite({
      email: "loc-promotable@t.com",
      displayName: "Loc Promotable",
      role: "viewer",
      scope: { kind: "location", locationId: britaliaId },
    });
    const updated = await ownerCaller().updateRole({
      membershipId: created.membershipId,
      type: "location",
      role: "cashier",
    });
    expect(updated.role).toBe("cashier");
  });
});

describe("team.archive", () => {
  it("sets status='removed' on the membership row", async () => {
    const created = await ownerCaller().invite({
      email: "archive-me@t.com",
      displayName: "Archive Me",
      role: "viewer",
      scope: { kind: "business" },
    });
    const archived = await ownerCaller().archive({
      membershipId: created.membershipId,
      type: "business",
    });
    expect(archived.status).toBe("removed");
  });
});
