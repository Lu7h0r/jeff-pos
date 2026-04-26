import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { customersRouter } = await import("../customers");
const { paymentMethodsRouter } = await import("../payment-methods");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const customers = createCallerFactory(customersRouter);
const payments = createCallerFactory(paymentMethodsRouter);

let bizJeffId: number;
let bizOtherId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    {
      id: "u-jeff",
      name: "Jeff",
      email: "jeff-active@test.com",
      emailVerified: false,
      image: null,
    },
    {
      id: "u-other",
      name: "Other",
      email: "other-active@test.com",
      emailVerified: false,
      image: null,
    },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-active" },
      { name: "Other Studio", slug: "other-active" },
    ])
    .returning();

  bizJeffId = bizJeff.id;
  bizOtherId = bizOther.id;

  await db.insert(schema.businessMembers).values([
    {
      business_id: bizJeffId,
      user_id: "u-jeff",
      role: "owner",
      status: "active",
    },
    {
      business_id: bizOtherId,
      user_id: "u-other",
      role: "owner",
      status: "active",
    },
  ]);
});

afterAll(async () => {
  await pg.close();
});

describe("customers.list with activeBusinessId", () => {
  it("creates customer with business_id when active context is set", async () => {
    const caller = customers(makeContext("u-jeff", { businessId: bizJeffId }));
    const c = await caller.create({
      name: "Jeff Customer",
      email: "jeff-cust1@t.com",
    });

    expect(c.business_id).toBe(bizJeffId);
    expect(c.user_uid).toBe("u-jeff");
  });

  it("creates customer with null business_id when no active context", async () => {
    const caller = customers(makeContext("u-jeff"));
    const c = await caller.create({
      name: "Legacy Customer",
      email: "legacy-cust@t.com",
    });

    expect(c.business_id).toBeNull();
  });

  it("with active business: returns customers of that business OR own user_uid (legacy fallback)", async () => {
    // Customer of u-other for biz-other (should be invisible to u-jeff)
    const otherCaller = customers(
      makeContext("u-other", { businessId: bizOtherId }),
    );
    await otherCaller.create({
      name: "Other Customer",
      email: "other-cust@t.com",
    });

    const jeffCaller = customers(
      makeContext("u-jeff", { businessId: bizJeffId }),
    );
    const list = await jeffCaller.list();

    const names = list.map((c) => c.name).sort();
    expect(names).toContain("Jeff Customer"); // own business
    expect(names).toContain("Legacy Customer"); // own user_uid fallback
    expect(names).not.toContain("Other Customer"); // different business
  });

  it("without active business: falls back to user_uid only (preserves pre-business behaviour)", async () => {
    const caller = customers(makeContext("u-jeff"));
    const list = await caller.list();

    // u-jeff created Jeff Customer (with business_id) and Legacy Customer
    // (without). Both are own user_uid → both visible in fallback mode.
    const names = list.map((c) => c.name).sort();
    expect(names).toContain("Jeff Customer");
    expect(names).toContain("Legacy Customer");
    expect(names).not.toContain("Other Customer");
  });
});

describe("paymentMethods.list with activeBusinessId", () => {
  it("creates payment method with business_id when active context is set", async () => {
    const caller = payments(makeContext("u-jeff", { businessId: bizJeffId }));
    const pm = await caller.create({ name: "Jeff Bancolombia" });

    expect(pm.business_id).toBe(bizJeffId);
  });

  it("creates payment method with null business_id when no active context (global)", async () => {
    const caller = payments(makeContext("u-jeff"));
    const pm = await caller.create({ name: "Cash Global" });

    expect(pm.business_id).toBeNull();
  });

  it("with active business: returns globals (NULL) PLUS business-scoped methods", async () => {
    // Seed Other-scoped method
    const otherCaller = payments(
      makeContext("u-other", { businessId: bizOtherId }),
    );
    await otherCaller.create({ name: "Other Daviplata" });

    const jeffCaller = payments(
      makeContext("u-jeff", { businessId: bizJeffId }),
    );
    const list = await jeffCaller.list();

    const names = list.map((pm) => pm.name).sort();
    expect(names).toContain("Cash Global"); // NULL business_id
    expect(names).toContain("Jeff Bancolombia"); // own business
    expect(names).not.toContain("Other Daviplata"); // different business
  });

  it("without active business: returns ALL methods (preserves pre-business behaviour)", async () => {
    const caller = payments(makeContext("u-jeff"));
    const list = await caller.list();

    const names = list.map((pm) => pm.name).sort();
    // Pre-business behaviour returns everything. This is consistent with the
    // existing payment-methods.test.ts which already verifies this contract.
    expect(names).toContain("Cash Global");
    expect(names).toContain("Jeff Bancolombia");
    expect(names).toContain("Other Daviplata");
  });
});
