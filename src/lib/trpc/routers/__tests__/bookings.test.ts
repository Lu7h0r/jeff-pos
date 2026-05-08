import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDb, makeContext, SCHEMA_DDL } from "./helpers";

const { pg, db } = createTestDb();
mock.module("@/lib/db", () => ({ db, pglite: pg }));

const { bookingsRouter } = await import("../bookings");
const { createCallerFactory } = await import("../../init");
const schema = await import("@/lib/db/schema");

const factory = createCallerFactory(bookingsRouter);
const callerAs = (uid: string, businessId?: number, locationId?: number) =>
  factory(
    makeContext(uid, {
      businessId: businessId ?? null,
      locationId: locationId ?? null,
    }),
  );

let bizId = 0;
let locationAId = 0;
let locationBId = 0;
let customerId = 0;
let staffId = 0;

beforeAll(async () => {
  await pg.exec(SCHEMA_DDL);

  await db.insert(schema.user).values({
    id: "u-bookings",
    name: "User Bookings",
    email: "bookings@test.com",
    emailVerified: false,
    image: null,
  });

  const [biz] = await db
    .insert(schema.businesses)
    .values({ name: "Studio Bookings", slug: "studio-bookings" })
    .returning();
  bizId = biz.id;

  await db.insert(schema.businessMembers).values({
    business_id: bizId,
    user_id: "u-bookings",
    role: "owner",
    status: "active",
  });

  const [locationA, locationB] = await db
    .insert(schema.locations)
    .values([
      { business_id: bizId, name: "Amparo", slug: "amparo" },
      { business_id: bizId, name: "Britalia", slug: "britalia" },
    ])
    .returning();
  locationAId = locationA.id;
  locationBId = locationB.id;

  const [customer] = await db
    .insert(schema.customers)
    .values({
      name: "Cliente Agenda",
      email: "cliente-agenda@test.com",
      user_uid: "u-bookings",
      business_id: bizId,
    })
    .returning();
  customerId = customer.id;

  const [staff] = await db
    .insert(schema.staffMembers)
    .values({
      business_id: bizId,
      display_name: "Artista Agenda",
      default_split: "staff_30_house_70",
    })
    .returning();
  staffId = staff.id;
});

afterAll(async () => {
  await pg.close();
});

describe("bookings router", () => {
  it("create + list filtered by day", async () => {
    const caller = callerAs("u-bookings", bizId, locationAId);
    const startsAt = new Date("2026-05-10T10:00:00.000Z");
    const endsAt = new Date("2026-05-10T11:00:00.000Z");

    const created = await caller.create({
      locationId: locationAId,
      customerId,
      staffId,
      serviceKind: "tattoo",
      title: "Tatuaje floral",
      startsAt,
      endsAt,
    });

    expect(created.status).toBe("pending");
    expect(created.location_id).toBe(locationAId);

    const list = await caller.list({
      startsAt: new Date("2026-05-10T00:00:00.000Z"),
      endsAt: new Date("2026-05-10T23:59:59.999Z"),
      locationId: locationAId,
    });

    expect(list.length).toBe(1);
    expect(list[0].id).toBe(created.id);
  });

  it("updateStatus transitions booking", async () => {
    const caller = callerAs("u-bookings", bizId, locationAId);
    const created = await caller.create({
      locationId: locationAId,
      serviceKind: "piercing",
      title: "Piercing lóbulo",
      startsAt: new Date("2026-05-11T13:00:00.000Z"),
      endsAt: new Date("2026-05-11T13:30:00.000Z"),
    });

    const updated = await caller.updateStatus({
      bookingId: created.id,
      status: "confirmed",
    });

    expect(updated.status).toBe("confirmed");
  });

  it("convertToServiceAgreement creates link once", async () => {
    const caller = callerAs("u-bookings", bizId, locationBId);
    const created = await caller.create({
      locationId: locationBId,
      customerId,
      serviceKind: "other",
      title: "Servicio personalizado",
      startsAt: new Date("2026-05-12T09:00:00.000Z"),
      endsAt: new Date("2026-05-12T10:30:00.000Z"),
    });

    const first = await caller.convertToServiceAgreement({ bookingId: created.id });
    expect(first.created).toBe(true);
    expect(first.serviceAgreementId).toBeGreaterThan(0);
    expect(first.booking.service_agreement_id).toBe(first.serviceAgreementId);

    const second = await caller.convertToServiceAgreement({ bookingId: created.id });
    expect(second.created).toBe(false);
    expect(second.serviceAgreementId).toBe(first.serviceAgreementId);

    const [agreement] = await db
      .select()
      .from(schema.serviceAgreements)
      .where(eq(schema.serviceAgreements.id, first.serviceAgreementId));
    expect(agreement.total_agreed_amount).toBe(1);
  });
});
