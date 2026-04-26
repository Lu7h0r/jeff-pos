import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { staffRouter } = await import("../staff");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(staffRouter);
const callerAs = (uid: string, businessId: number | null = null) =>
  factory(makeContext(uid, { businessId }));

let bizJeffId: number;
let bizOtherId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff-staff@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-staff@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-staff" },
      { name: "Other Studio", slug: "other-staff" },
    ])
    .returning();
  bizJeffId = bizJeff.id;
  bizOtherId = bizOther.id;
});

afterAll(async () => {
  await pg.close();
});

describe("staff CRUD", () => {
  it("creates and lists a staff member with kind + commission_rate stored as basis points", async () => {
    const created = await callerAs("u-jeff", bizJeffId).create({
      displayName: "Sample Artist",
      kind: "artist",
      commissionRate: 3000,
      defaultSplit: "staff_30_house_70",
    });
    expect(created.business_id).toBe(bizJeffId);
    expect(created.commission_rate).toBe(3000);
    expect(created.default_split).toBe("staff_30_house_70");
    expect(created.archived).toBe(false);

    const list = await callerAs("u-jeff", bizJeffId).list();
    expect(list.some((s) => s.id === created.id)).toBe(true);
  });

  it("updates fields", async () => {
    const created = await callerAs("u-jeff", bizJeffId).create({
      displayName: "Apprentice",
      kind: "apprentice",
    });
    const updated = await callerAs("u-jeff", bizJeffId).update({
      id: created.id,
      kind: "artist",
      commissionRate: 5000,
      defaultSplit: "staff_50_house_50",
      notes: "promoted",
    });
    expect(updated.kind).toBe("artist");
    expect(updated.commission_rate).toBe(5000);
    expect(updated.default_split).toBe("staff_50_house_50");
    expect(updated.notes).toBe("promoted");
  });

  it("archives a staff member and removes them from list()", async () => {
    const created = await callerAs("u-jeff", bizJeffId).create({
      displayName: "To archive",
    });
    const archived = await callerAs("u-jeff", bizJeffId).archive({
      id: created.id,
    });
    expect(archived.archived).toBe(true);

    const list = await callerAs("u-jeff", bizJeffId).list();
    expect(list.some((s) => s.id === created.id)).toBe(false);
  });

  it("commissionRate persists as integer basis points (no float coercion)", async () => {
    const created = await callerAs("u-jeff", bizJeffId).create({
      displayName: "Bps test",
      commissionRate: 4250,
    });
    const [row] = await db
      .select()
      .from(schema.staffMembers)
      .where(eq(schema.staffMembers.id, created.id));
    expect(row.commission_rate).toBe(4250);
    expect(Number.isInteger(row.commission_rate)).toBe(true);
  });

  it("rejects update for staff of another business (FORBIDDEN)", async () => {
    const otherCreated = await callerAs("u-other", bizOtherId).create({
      displayName: "Other Artist",
    });
    await expect(
      callerAs("u-jeff", bizJeffId).update({
        id: otherCreated.id,
        displayName: "hijack",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("cross-business isolation in list", async () => {
    await callerAs("u-other", bizOtherId).create({ displayName: "Other-only" });
    const jeffList = await callerAs("u-jeff", bizJeffId).list();
    expect(jeffList.every((s) => s.business_id === bizJeffId)).toBe(true);
  });
});
