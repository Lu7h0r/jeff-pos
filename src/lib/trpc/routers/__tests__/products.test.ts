import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { productsRouter } = await import("../products");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

// Pre-seeded business ids resolved in beforeAll. Each test user owns its
// own business so cross-user filtering still works after Batch 4 made
// products.business_id NOT NULL.
let bizUser1Id = 0;
let bizOtherId = 0;

const factory = createCallerFactory(productsRouter);
const caller = {
  create: (input: Parameters<ReturnType<typeof factory>["create"]>[0]) =>
    factory(makeContext("user-1", { businessId: bizUser1Id })).create(input),
  list: () => factory(makeContext("user-1", { businessId: bizUser1Id })).list(),
  update: (input: Parameters<ReturnType<typeof factory>["update"]>[0]) =>
    factory(makeContext("user-1", { businessId: bizUser1Id })).update(input),
  delete: (input: Parameters<ReturnType<typeof factory>["delete"]>[0]) =>
    factory(makeContext("user-1", { businessId: bizUser1Id })).delete(input),
};
const callerAs = (uid: string, businessId: number) =>
  factory(makeContext(uid, { businessId }));

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "user-1", name: "U1", email: "u1@test.com", emailVerified: false, image: null },
    { id: "other-user", name: "Other", email: "other@test.com", emailVerified: false, image: null },
    { id: "attacker", name: "Atk", email: "atk@test.com", emailVerified: false, image: null },
  ]);

  const [b1, bOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "User1 Biz", slug: "user1" },
      { name: "Other Biz", slug: "other-biz" },
    ])
    .returning();
  bizUser1Id = b1.id;
  bizOtherId = bOther.id;

  await db.insert(schema.businessMembers).values([
    { business_id: bizUser1Id, user_id: "user-1", role: "owner", status: "active" },
    { business_id: bizOtherId, user_id: "other-user", role: "owner", status: "active" },
    { business_id: bizUser1Id, user_id: "attacker", role: "cashier", status: "active" },
  ]);
});
afterAll(async () => { await pg.close(); });

describe("products.list", () => {
  it("returns empty array initially", async () => {
    const list = await caller.list();
    expect(list).toEqual([]);
    expect(list.length).toBe(0);
  });

  it("filters by user_uid — does not leak cross-user data", async () => {
    await caller.create({ name: "P1", price: 100, in_stock: 10 });
    const other = callerAs("other-user", bizOtherId);
    await other.create({ name: "P-other", price: 50, in_stock: 5 });

    const list = await caller.list();
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("P1");
    expect(list.some((p) => p.name === "P-other")).toBe(false);

    const otherList = await other.list();
    expect(otherList.length).toBe(1);
    expect(otherList[0].name).toBe("P-other");
  });

  it("returns correct shape with all expected fields", async () => {
    const list = await caller.list();
    const p = list[0];
    expect(typeof p.id).toBe("number");
    expect(typeof p.name).toBe("string");
    expect(typeof p.price).toBe("number");
    expect(typeof p.in_stock).toBe("number");
    expect(typeof p.user_uid).toBe("string");
    expect(Array.isArray(p.image_urls)).toBe(true);
    expect(p.created_at).toBeInstanceOf(Date);
  });
});

describe("products.create", () => {
  it("creates and persists — visible in list()", async () => {
    const before = await caller.list();
    const p = await caller.create({ name: "Widget", price: 1500, in_stock: 20 });
    expect(p.name).toBe("Widget");
    expect(p.price).toBe(1500);
    expect(p.in_stock).toBe(20);
    expect(p.user_uid).toBe("user-1");
    expect(p.id).toBeGreaterThan(0);

    const after = await caller.list();
    expect(after.length).toBe(before.length + 1);
    const found = after.find((x) => x.id === p.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Widget");
    expect(found!.price).toBe(1500);
  });

  it("omitted optional fields are null in DB", async () => {
    const p = await caller.create({ name: "Bare", price: 100, in_stock: 0 });
    expect(p.description).toBeNull();
    expect(p.category).toBeNull();

    const list = await caller.list();
    const persisted = list.find((x) => x.id === p.id)!;
    expect(persisted.description).toBeNull();
    expect(persisted.category).toBeNull();
  });

  it("provided optional fields persist correctly", async () => {
    const p = await caller.create({
      name: "Full",
      price: 999,
      in_stock: 5,
      description: "desc",
      category: "cat",
      cost_amount: 500,
      image_url: "https://cdn.example.com/p1.jpg",
      image_urls: [
        "https://cdn.example.com/p1.jpg",
        "https://cdn.example.com/p2.jpg",
      ],
    });
    expect(p.description).toBe("desc");
    expect(p.category).toBe("cat");
    expect(p.cost_amount).toBe(500);
    expect(p.image_url).toBe("https://cdn.example.com/p1.jpg");
    expect(p.image_urls.length).toBe(2);

    const list = await caller.list();
    const persisted = list.find((x) => x.id === p.id)!;
    expect(persisted.description).toBe("desc");
    expect(persisted.category).toBe("cat");
    expect(persisted.cost_amount).toBe(500);
  });

  it("rejects cost greater than price", async () => {
    await expect(
      caller.create({ name: "Bad margin", price: 100, cost_amount: 101, in_stock: 1 }),
    ).rejects.toThrow();
  });

  it("rejects name: empty string — no record created", async () => {
    const before = await caller.list();
    await expect(caller.create({ name: "", price: 100, in_stock: 1 })).rejects.toThrow();
    const after = await caller.list();
    expect(after.length).toBe(before.length);
  });

  it("rejects in_stock: -1 — no record created", async () => {
    const before = await caller.list();
    await expect(caller.create({ name: "Bad", price: 100, in_stock: -1 })).rejects.toThrow();
    const after = await caller.list();
    expect(after.length).toBe(before.length);
  });
});

describe("products.update", () => {
  it("updates fields and change persists in list()", async () => {
    const p = await caller.create({ name: "Old", price: 100, in_stock: 1 });
    const updated = await caller.update({ id: p.id, name: "New", price: 200 });
    expect(updated.name).toBe("New");
    expect(updated.price).toBe(200);

    const list = await caller.list();
    const persisted = list.find((x) => x.id === p.id)!;
    expect(persisted.name).toBe("New");
    expect(persisted.price).toBe(200);
    expect(persisted.in_stock).toBe(1); // unchanged field preserved
  });

  it("cross-user update fails and original data is untouched", async () => {
    const p = await caller.create({ name: "Mine", price: 100, in_stock: 1 });
    const other = callerAs("attacker", bizUser1Id);
    await expect(other.update({ id: p.id, name: "Hacked" })).rejects.toThrow();

    const list = await caller.list();
    const original = list.find((x) => x.id === p.id)!;
    expect(original.name).toBe("Mine");
    expect(original.price).toBe(100);
  });
});

describe("products.delete", () => {
  it("deletes a product — no longer in list()", async () => {
    const p = await caller.create({ name: "ToDelete", price: 100, in_stock: 1 });
    const before = await caller.list();
    expect(before.some((x) => x.id === p.id)).toBe(true);

    await caller.delete({ id: p.id });

    const after = await caller.list();
    expect(after.some((x) => x.id === p.id)).toBe(false);
    expect(after.length).toBe(before.length - 1);
  });

  it("is idempotent — deleting same id twice does not error", async () => {
    const p = await caller.create({ name: "DelTwice", price: 100, in_stock: 1 });
    await caller.delete({ id: p.id });
    const result = await caller.delete({ id: p.id });
    expect(result.success).toBe(true);

    const list = await caller.list();
    expect(list.some((x) => x.id === p.id)).toBe(false);
  });
});
