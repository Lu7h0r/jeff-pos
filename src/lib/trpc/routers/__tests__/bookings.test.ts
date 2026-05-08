import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
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
let staffAltId = 0;
let outsideBusinessStaffId = 0;

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

  const [staff, staffAlt] = await db
    .insert(schema.staffMembers)
    .values([
      {
        business_id: bizId,
        display_name: "Artista Agenda",
        default_split: "staff_30_house_70",
      },
      {
        business_id: bizId,
        display_name: "Artista Alterno",
        default_split: "staff_30_house_70",
      },
    ])
    .returning();
  staffId = staff.id;
  staffAltId = staffAlt.id;

  const [outsideBusiness] = await db
    .insert(schema.businesses)
    .values({ name: "Otro Studio", slug: "otro-studio" })
    .returning();
  const [outsideStaff] = await db
    .insert(schema.staffMembers)
    .values({
      business_id: outsideBusiness.id,
      display_name: "Artista Externo",
      default_split: "staff_30_house_70",
    })
    .returning();
  outsideBusinessStaffId = outsideStaff.id;
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
    expect(created.confirmation_status).toBe("pending");
    expect(created.location_id).toBe(locationAId);

    const list = await caller.list({
      startsAt: new Date("2026-05-10T00:00:00.000Z"),
      endsAt: new Date("2026-05-10T23:59:59.999Z"),
      locationId: locationAId,
    });

    expect(list.length).toBe(1);
    expect(list[0].id).toBe(created.id);

    const history = await caller.listEvents({ bookingId: created.id });
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].event_type).toBe("create");

    const [createdOutbox] = await db
      .select()
      .from(schema.followUpOutboxEvents)
      .where(eq(schema.followUpOutboxEvents.booking_id, created.id));
    expect(createdOutbox).toBeDefined();
    expect(createdOutbox.event_type).toBe("booking_created");
    expect(createdOutbox.idempotency_key).toBe(`booking_created:booking:${created.id}`);
  });

  it("updateStatus transitions booking", async () => {
    const caller = callerAs("u-bookings", bizId, locationAId);
    const created = await caller.create({
      locationId: locationAId,
      serviceKind: "piercing",
      staffId,
      title: "Piercing lóbulo",
      startsAt: new Date("2026-05-11T13:00:00.000Z"),
      endsAt: new Date("2026-05-11T13:30:00.000Z"),
    });

    const updated = await caller.updateStatus({
      bookingId: created.id,
      status: "confirmed",
    });

    expect(updated.status).toBe("confirmed");

    const history = await caller.listEvents({ bookingId: created.id });
    expect(history[0].event_type).toBe("confirm");

    const [confirmedOutbox] = await db
      .select()
      .from(schema.followUpOutboxEvents)
      .where(eq(schema.followUpOutboxEvents.idempotency_key, `booking_confirmed:booking:${created.id}`));
    expect(confirmedOutbox).toBeDefined();
    expect(confirmedOutbox.event_type).toBe("booking_confirmed");
  });

  it("reschedule and cancel persist events and outbox", async () => {
    const caller = callerAs("u-bookings", bizId, locationAId);
    const created = await caller.create({
      locationId: locationAId,
      serviceKind: "tattoo",
      staffId,
      title: "Sesion para reprogramar",
      startsAt: new Date("2026-05-13T09:00:00.000Z"),
      endsAt: new Date("2026-05-13T10:00:00.000Z"),
    });

    await caller.reschedule({
      bookingId: created.id,
      startsAt: new Date("2026-05-13T11:00:00.000Z"),
      endsAt: new Date("2026-05-13T12:00:00.000Z"),
    });
    await caller.cancel({ bookingId: created.id });

    const history = await caller.listEvents({ bookingId: created.id });
    const eventTypes = history.map((item) => item.event_type);
    expect(eventTypes).toContain("reschedule");
    expect(eventTypes).toContain("cancel");

    const [rescheduledOutbox] = await db
      .select()
      .from(schema.followUpOutboxEvents)
      .where(eq(schema.followUpOutboxEvents.idempotency_key, `booking_rescheduled:booking:${created.id}`));
    expect(rescheduledOutbox).toBeDefined();
    expect(rescheduledOutbox.event_type).toBe("booking_rescheduled");

    const [cancelledOutbox] = await db
      .select()
      .from(schema.followUpOutboxEvents)
      .where(eq(schema.followUpOutboxEvents.idempotency_key, `booking_cancelled:booking:${created.id}`));
    expect(cancelledOutbox).toBeDefined();
    expect(cancelledOutbox.event_type).toBe("booking_cancelled");
  });

  it("blocks completed status without service agreement", async () => {
    const caller = callerAs("u-bookings", bizId, locationAId);
    const created = await caller.create({
      locationId: locationAId,
      serviceKind: "tattoo",
      staffId,
      title: "Bloqueo completado sin acuerdo",
      startsAt: new Date("2026-05-11T15:00:00.000Z"),
      endsAt: new Date("2026-05-11T16:00:00.000Z"),
    });

    await expect(
      caller.updateStatus({ bookingId: created.id, status: "completed" }),
    ).rejects.toMatchObject<Partial<TRPCError>>({
      code: "PRECONDITION_FAILED",
    });
  });

  it("convertToServiceAgreement creates link once", async () => {
    const caller = callerAs("u-bookings", bizId, locationBId);
    const created = await caller.create({
      locationId: locationBId,
      customerId,
      staffId,
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

  it("registerExternalResponse applies confirmation and reschedule", async () => {
    const caller = callerAs("u-bookings", bizId, locationAId);
    const created = await caller.create({
      locationId: locationAId,
      serviceKind: "tattoo",
      staffId,
      title: "Respuesta externa",
      startsAt: new Date("2026-05-13T10:00:00.000Z"),
      endsAt: new Date("2026-05-13T11:00:00.000Z"),
    });

    const confirmed = await caller.registerExternalResponse({
      bookingId: created.id,
      response: "confirm",
    });
    expect(confirmed.confirmation_status).toBe("confirmed");
    expect(confirmed.status).toBe("confirmed");

    const rescheduled = await caller.registerExternalResponse({
      bookingId: created.id,
      response: "reschedule",
      startsAt: new Date("2026-05-13T12:00:00.000Z"),
      endsAt: new Date("2026-05-13T13:00:00.000Z"),
    });
    expect(rescheduled.confirmation_status).toBe("pending");
    expect(rescheduled.status).toBe("pending");
    expect(rescheduled.starts_at.toISOString()).toBe("2026-05-13T12:00:00.000Z");
  });

  it("summary returns base booking KPIs", async () => {
    const caller = callerAs("u-bookings", bizId, locationAId);

    const confirmedBooking = await caller.create({
      locationId: locationAId,
      customerId,
      staffId,
      serviceKind: "tattoo",
      title: "KPI confirmado",
      startsAt: new Date("2026-05-14T09:00:00.000Z"),
      endsAt: new Date("2026-05-14T10:00:00.000Z"),
    });
    await caller.registerExternalResponse({
      bookingId: confirmedBooking.id,
      response: "confirm",
    });
    await caller.convertToServiceAgreement({ bookingId: confirmedBooking.id });

    const noShowBooking = await caller.create({
      locationId: locationAId,
      serviceKind: "other",
      staffId,
      title: "KPI no show",
      startsAt: new Date("2026-05-14T11:00:00.000Z"),
      endsAt: new Date("2026-05-14T12:00:00.000Z"),
    });
    await caller.updateStatus({ bookingId: noShowBooking.id, status: "no_show" });

    const pendingBooking = await caller.create({
      locationId: locationAId,
      serviceKind: "piercing",
      staffId: staffAltId,
      title: "KPI pendiente",
      startsAt: new Date("2026-05-14T14:00:00.000Z"),
      endsAt: new Date("2026-05-14T14:30:00.000Z"),
    });
    expect(pendingBooking.confirmation_status).toBe("pending");

    const summary = await caller.summary({
      startsAt: new Date("2026-05-14T00:00:00.000Z"),
      endsAt: new Date("2026-05-14T23:59:59.999Z"),
      locationId: locationAId,
    });

    expect(summary.totalBookings).toBe(3);
    expect(summary.confirmedRate).toBeCloseTo(1 / 3);
    expect(summary.noShowRate).toBeCloseTo(1 / 3);
    expect(summary.conversionToServiceAgreementRate).toBeCloseTo(1 / 3);

    const summaryByStaff = await caller.summary({
      startsAt: new Date("2026-05-14T00:00:00.000Z"),
      endsAt: new Date("2026-05-14T23:59:59.999Z"),
      locationId: locationAId,
      staffId,
    });
    expect(summaryByStaff.totalBookings).toBe(2);
  });

  it("requires staff and blocks overlapping bookings for same staff+location", async () => {
    const caller = callerAs("u-bookings", bizId, locationAId);

    await expect(
      caller.create({
        locationId: locationAId,
        serviceKind: "tattoo",
        title: "Sin artista",
        startsAt: new Date("2026-05-15T09:00:00.000Z"),
        endsAt: new Date("2026-05-15T10:00:00.000Z"),
      }),
    ).rejects.toBeDefined();

    await caller.create({
      locationId: locationAId,
      staffId,
      serviceKind: "tattoo",
      title: "Base solape",
      startsAt: new Date("2026-05-15T10:00:00.000Z"),
      endsAt: new Date("2026-05-15T11:00:00.000Z"),
    });

    await expect(
      caller.create({
        locationId: locationAId,
        staffId,
        serviceKind: "piercing",
        title: "Cruza horario",
        startsAt: new Date("2026-05-15T10:30:00.000Z"),
        endsAt: new Date("2026-05-15T11:30:00.000Z"),
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "CONFLICT" });
  });

  it("rejects create when staff is outside active business", async () => {
    const caller = callerAs("u-bookings", bizId, locationAId);

    await expect(
      caller.create({
        locationId: locationAId,
        staffId: outsideBusinessStaffId,
        serviceKind: "tattoo",
        title: "Staff fuera del negocio",
        startsAt: new Date("2026-05-15T13:00:00.000Z"),
        endsAt: new Date("2026-05-15T14:00:00.000Z"),
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "FORBIDDEN" });
  });

  it("blocks overlap on reschedule", async () => {
    const caller = callerAs("u-bookings", bizId, locationAId);

    const bookingA = await caller.create({
      locationId: locationAId,
      staffId,
      serviceKind: "tattoo",
      title: "A",
      startsAt: new Date("2026-05-16T09:00:00.000Z"),
      endsAt: new Date("2026-05-16T10:00:00.000Z"),
    });
    const bookingB = await caller.create({
      locationId: locationAId,
      staffId,
      serviceKind: "tattoo",
      title: "B",
      startsAt: new Date("2026-05-16T10:30:00.000Z"),
      endsAt: new Date("2026-05-16T11:30:00.000Z"),
    });

    await expect(
      caller.reschedule({
        bookingId: bookingB.id,
        startsAt: new Date("2026-05-16T09:30:00.000Z"),
        endsAt: new Date("2026-05-16T10:30:00.000Z"),
      }),
    ).rejects.toMatchObject<Partial<TRPCError>>({ code: "CONFLICT" });

    expect(bookingA.id).toBeGreaterThan(0);
  });

  it("applies summary filters by date range, location and staff", async () => {
    const caller = callerAs("u-bookings", bizId, locationAId);

    await caller.create({
      locationId: locationAId,
      staffId,
      serviceKind: "tattoo",
      title: "Summary locA staffA",
      startsAt: new Date("2026-05-20T09:00:00.000Z"),
      endsAt: new Date("2026-05-20T10:00:00.000Z"),
    });
    await caller.create({
      locationId: locationAId,
      staffId: staffAltId,
      serviceKind: "tattoo",
      title: "Summary locA staffB",
      startsAt: new Date("2026-05-20T10:00:00.000Z"),
      endsAt: new Date("2026-05-20T11:00:00.000Z"),
    });
    await caller.create({
      locationId: locationBId,
      staffId,
      serviceKind: "tattoo",
      title: "Summary locB staffA",
      startsAt: new Date("2026-05-20T11:00:00.000Z"),
      endsAt: new Date("2026-05-20T12:00:00.000Z"),
    });
    await caller.create({
      locationId: locationAId,
      staffId,
      serviceKind: "tattoo",
      title: "Summary fuera de rango",
      startsAt: new Date("2026-05-22T09:00:00.000Z"),
      endsAt: new Date("2026-05-22T10:00:00.000Z"),
    });

    const byLocationAndRange = await caller.summary({
      startsAt: new Date("2026-05-20T00:00:00.000Z"),
      endsAt: new Date("2026-05-20T23:59:59.999Z"),
      locationId: locationAId,
    });
    expect(byLocationAndRange.totalBookings).toBe(2);

    const byLocationStaffAndRange = await caller.summary({
      startsAt: new Date("2026-05-20T00:00:00.000Z"),
      endsAt: new Date("2026-05-20T23:59:59.999Z"),
      locationId: locationAId,
      staffId,
    });
    expect(byLocationStaffAndRange.totalBookings).toBe(1);
  });
});
