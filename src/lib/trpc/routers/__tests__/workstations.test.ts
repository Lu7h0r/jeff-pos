import { mock, describe, it, expect, beforeAll, afterAll } from "bun:test";
import { TRPCError } from "@trpc/server";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { workstationsRouter } = await import("../workstations");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(workstationsRouter);
const callerAs = (
  uid: string,
  businessId: number | null = null,
  locationId: number | null = null,
) => factory(makeContext(uid, { businessId, locationId }));

let bizJeffId: number;
let bizOtherId: number;
let amparoId: number;
let britaliaId: number;
let otherLocationId: number;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values([
    { id: "u-jeff", name: "Jeff", email: "jeff-ws@test.com", emailVerified: false, image: null },
    { id: "u-other", name: "Other", email: "other-ws@test.com", emailVerified: false, image: null },
  ]);

  const [bizJeff, bizOther] = await db
    .insert(schema.businesses)
    .values([
      { name: "Jeff Studio", slug: "jeff-ws" },
      { name: "Other Studio", slug: "other-ws" },
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

describe("workstations CRUD", () => {
  it("creates a workstation at a location", async () => {
    const created = await callerAs("u-jeff", bizJeffId).create({
      locationId: amparoId,
      name: "Cabina 1",
      kind: "tattoo",
    });
    expect(created.business_id).toBe(bizJeffId);
    expect(created.location_id).toBe(amparoId);
    expect(created.kind).toBe("tattoo");
  });

  it("rejects creating a workstation at a location of another business (FORBIDDEN)", async () => {
    await expect(
      callerAs("u-jeff", bizJeffId).create({
        locationId: otherLocationId,
        name: "hijack",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" } satisfies Partial<TRPCError>);
  });

  it("list filters by locationId from input", async () => {
    await callerAs("u-jeff", bizJeffId).create({
      locationId: britaliaId,
      name: "Box Piercer",
      kind: "piercing",
    });
    const amparoList = await callerAs("u-jeff", bizJeffId).list({
      locationId: amparoId,
    });
    expect(amparoList.every((w) => w.location_id === amparoId)).toBe(true);
    expect(amparoList.length).toBeGreaterThan(0);

    const britaliaList = await callerAs("u-jeff", bizJeffId).list({
      locationId: britaliaId,
    });
    expect(britaliaList.every((w) => w.location_id === britaliaId)).toBe(true);
  });

  it("archive removes from list()", async () => {
    const created = await callerAs("u-jeff", bizJeffId).create({
      locationId: amparoId,
      name: "Temp",
    });
    await callerAs("u-jeff", bizJeffId).archive({ id: created.id });
    const list = await callerAs("u-jeff", bizJeffId).list({
      locationId: amparoId,
    });
    expect(list.some((w) => w.id === created.id)).toBe(false);
  });

  it("cross-business isolation in list", async () => {
    await callerAs("u-other", bizOtherId).create({
      locationId: otherLocationId,
      name: "OtherWS",
      kind: "general",
    });
    const jeffList = await callerAs("u-jeff", bizJeffId).list({});
    expect(jeffList.every((w) => w.business_id === bizJeffId)).toBe(true);
  });
});
