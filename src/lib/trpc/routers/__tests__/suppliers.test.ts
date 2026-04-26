import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { suppliersRouter } = await import("../suppliers");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(suppliersRouter);
const callerAs = (uid: string, businessId: number | null = null) =>
  factory(makeContext(uid, { businessId }));

let bizJeffId: number;
let bizOtherId: number;
let otherBizSupplierId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff-sup@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-sup@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-sup" },
      { name: "Other Studio", slug: "other-sup" },
    ])
    .returning();
  bizJeffId = bizJeff.id;
  bizOtherId = bizOther.id;

  await db.insert(schema.businessMembers).values([
    { business_id: bizJeffId, user_id: "u-jeff", role: "owner", status: "active" },
    { business_id: bizOtherId, user_id: "u-other", role: "owner", status: "active" },
  ]);

  const [otherSupplier] = await db
    .insert(schema.suppliers)
    .values({ business_id: bizOtherId, name: "Other Supplier" })
    .returning();
  otherBizSupplierId = otherSupplier.id;
});

afterAll(async () => {
  await pg.close();
});

describe("suppliers CRUD", () => {
  it("create + list scoped by active business", async () => {
    const created = await callerAs("u-jeff", bizJeffId).create({
      name: "Distribuidora Demo",
      contactEmail: "demo@distri.test",
      contactPhone: "555",
    });
    expect(created.business_id).toBe(bizJeffId);
    expect(created.name).toBe("Distribuidora Demo");
    expect(created.archived).toBe(false);

    const list = await callerAs("u-jeff", bizJeffId).list();
    expect(list.some((s) => s.id === created.id)).toBe(true);
  });

  it("update modifies fields and persists", async () => {
    const created = await callerAs("u-jeff", bizJeffId).create({
      name: "Tmp",
    });
    const updated = await callerAs("u-jeff", bizJeffId).update({
      id: created.id,
      name: "Renamed",
      contactPhone: "999",
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.contact_phone).toBe("999");
  });

  it("archive sets archived=true and removes from list (idempotent)", async () => {
    const created = await callerAs("u-jeff", bizJeffId).create({ name: "ToArchive" });
    const archived = await callerAs("u-jeff", bizJeffId).archive({ id: created.id });
    expect(archived.archived).toBe(true);

    // Idempotent: archiving again should not throw
    const archivedAgain = await callerAs("u-jeff", bizJeffId).archive({ id: created.id });
    expect(archivedAgain.archived).toBe(true);

    const list = await callerAs("u-jeff", bizJeffId).list();
    expect(list.some((s) => s.id === created.id)).toBe(false);
  });

  it("rejects without active business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", null).list(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("cross-business isolation: u-jeff cannot update other biz supplier", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).update({
        id: otherBizSupplierId,
        name: "Hacked",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);

    const [unchanged] = await db
      .select()
      .from(schema.suppliers)
      .where(eq(schema.suppliers.id, otherBizSupplierId));
    expect(unchanged.name).toBe("Other Supplier");
  });

  it("cross-business isolation: u-jeff list does not include other biz suppliers", async () => {
    const list = await callerAs("u-jeff", bizJeffId).list();
    expect(list.every((s) => s.business_id === bizJeffId)).toBe(true);
    expect(list.some((s) => s.id === otherBizSupplierId)).toBe(false);
  });
});
