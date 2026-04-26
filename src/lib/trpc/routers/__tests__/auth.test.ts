import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { productsRouter } = await import("../products");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

let bizU1: number;
let bizU2: number;

const factory = createCallerFactory(productsRouter);
const unauth = factory({ user: null as any });
const undefinedUser = factory({ user: undefined as any });
const authed = {
  list: () => factory(makeContext("u1", { businessId: bizU1 })).list(),
  create: (input: Parameters<ReturnType<typeof factory>["create"]>[0]) =>
    factory(makeContext("u1", { businessId: bizU1 })).create(input),
};

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u1", name: "U1", email: "u1@auth.com", emailVerified: false, image: null },
    { id: "u2", name: "U2", email: "u2@auth.com", emailVerified: false, image: null },
  ]);

  const [b1, b2] = await db
    .insert(schema.businesses)
    .values([
      { name: "Biz U1", slug: "u1-biz" },
      { name: "Biz U2", slug: "u2-biz" },
    ])
    .returning();
  bizU1 = b1.id;
  bizU2 = b2.id;

  await db.insert(schema.businessMembers).values([
    { business_id: bizU1, user_id: "u1", role: "owner", status: "active" },
    { business_id: bizU2, user_id: "u2", role: "owner", status: "active" },
  ]);
});
afterAll(async () => { await pg.close(); });

describe("protectedProcedure", () => {
  it("rejects when user is null", async () => {
    await expect(unauth.list()).rejects.toThrow("UNAUTHORIZED");
  });

  it("rejects when user is undefined", async () => {
    await expect(undefinedUser.list()).rejects.toThrow("UNAUTHORIZED");
  });

  it("proceeds when user is valid and returns array", async () => {
    const result = await authed.list();
    expect(result).toBeArray();
    expect(result.length).toBe(0);
  });

  it("populates user_uid from ctx.user.id and persists in DB", async () => {
    const product = await authed.create({ name: "Auth Test", price: 100, in_stock: 1 });
    expect(product.user_uid).toBe("u1");

    const list = await authed.list();
    const found = list.find((p) => p.id === product.id);
    expect(found).toBeDefined();
    expect(found!.user_uid).toBe("u1");
  });

  it("isolates data between users — each sees only own records", async () => {
    const callerB = factory(makeContext("u2", { businessId: bizU2 }));
    await callerB.create({ name: "User B Product", price: 200, in_stock: 5 });

    const listA = await authed.list();
    const listB = await callerB.list();

    expect(listA.length).toBeGreaterThanOrEqual(1);
    expect(listB.length).toBe(1);
    expect(listA.every((p) => p.user_uid === "u1")).toBe(true);
    expect(listA.some((p) => p.name === "User B Product")).toBe(false);
    expect(listB[0].name).toBe("User B Product");
    expect(listB[0].user_uid).toBe("u2");
  });
});
